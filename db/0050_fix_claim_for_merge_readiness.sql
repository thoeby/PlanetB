-- Fix: focused workers must not claim merge atoms until a child SOG
-- has been published. This is the live-database fix for claim_for().
--
-- 0043_pool.sql contained the same intended guard for claim_atom(), but
-- claim_for() bypassed it. This migration replaces claim_for() in the
-- already-migrated database.
--
-- CREATE OR REPLACE, not CREATE: db/0043_pool.sql already created this
-- function, so a plain CREATE raises "function claim_for already exists" —
-- which fails `make db-test` on a fresh database, and on an existing one is
-- swallowed by the migration runner as an "already there" error and recorded
-- as applied. Either way the guard below never reaches the database it was
-- written for.

CREATE OR REPLACE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT a2.* INTO a
    FROM atom a2
    JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
  AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
    ORDER BY a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE atom.id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;
