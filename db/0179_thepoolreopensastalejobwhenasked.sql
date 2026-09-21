-- 0179_thepoolreopensastalejobwhenasked.sql — a job the world no longer
-- builds is reopened the moment a tab asks for its work, the heartbeat says
-- what became of a piece, and a tab can see its own standing.
--
-- What was seen, after db/0178: a player pressed Render on other people's
-- tiles and got "n piece(s) left — press Render again" for ever, while their
-- own tiles — the ones they had pressed "Compile it all again" on — rendered.
-- Their own jobs were new, at train-v14; everybody else's were opened before
-- the trainer moved and still asked for train-v13, which db/0178's claim
-- filter rightly refused to hand out. db/0178 reopens those once, when it is
-- applied, and a world that has not had it applied, or that moves a version
-- again without a migration remembering to call refresh_stale_jobs, is back
-- in the same place: work the pool shows and nobody can take.
--
-- So the pool reopens a stale job when it is asked for. claim_atom, finding
-- ready work at a version algo_current does not name, refreshes before it
-- chooses; claim_for does the same for the one job it was asked about, and
-- follows the tile to the job that replaced it. Invariant 4 holds: ensure_job
-- is still the only thing that opens a job. Invariant 9 holds: the world
-- decides which job is the tile's; it computes nothing.
--
-- Two more things the page could not say:
--   * heartbeat's "not claimed by you" said nothing about what had happened.
--     It says now whether the piece was taken back by the world, handed to
--     somebody else, or already finished.
--   * A worker whose trust has fallen under trust_min('train') (db/0019) is
--     handed no training by claim_atom and told nothing. my_standing hands
--     the page the number and the thresholds, so Work · Settings can say it.

-- Whether any open job has work at a version the world no longer builds.
-- Cheap: `ready` atoms are few, and atom_state_op_idx finds them.
CREATE FUNCTION stale_work_waiting() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (
    SELECT 1 FROM atom a
    INNER JOIN job j ON j.id = a.job_id AND j.state = 'open'
    WHERE a.state = 'ready'
      AND a.algo_version IS DISTINCT FROM algo_current(a.op));
$$;

REVOKE ALL ON FUNCTION stale_work_waiting() FROM PUBLIC;

-- db/0178's claim_atom, refreshing first when there is something to refresh.
CREATE OR REPLACE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid   uuid;
    trust numeric;
    a     atom%rowtype;
    ops   text [] := CASE WHEN jsonb_typeof(p_caps -> 'ops') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_caps -> 'ops')) END;
    near  geometry := CASE WHEN jsonb_typeof(p_caps -> 'near') = 'object'
                           THEN st_setsrid(st_makepoint(
                               (p_caps -> 'near' ->> 'lon')::double precision,
                               (p_caps -> 'near' ->> 'lat')::double precision), world_srid()) END;
BEGIN
    PERFORM expire_claims();
    -- Only for a tab that says what it builds: it is the one that would be
    -- refused the stale piece. One that names nothing is handed it as before.
    IF p_caps ? 'algo' AND stale_work_waiting() THEN
        PERFORM refresh_stale_jobs();
    END IF;
    wid := my_worker(p_caps);
    SELECT w.trust INTO trust FROM worker w WHERE w.id = wid;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (ops IS NULL OR a2.op = ANY(ops))
      AND atom_fits(a2, p_caps)
      AND atom_builds(a2, p_caps)
      AND coalesce(trust, 0) >= trust_min(a2.op)
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
    ORDER BY j.bounty DESC,
        CASE WHEN near IS NULL THEN 0
             ELSE st_distance(st_centroid(tile_bbox(j.z, j.x, j.y)), near) END,
        a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;

-- db/0178's claim_for: a stale job is reopened, and the claim follows the
-- tile to the job that replaced it.
CREATE OR REPLACE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
    j   job%rowtype;
    t   tile%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT * INTO j FROM job WHERE id = p_job;
    IF p_caps ? 'algo' AND j.id IS NOT NULL AND EXISTS (
        SELECT 1 FROM atom a2 WHERE a2.job_id = j.id AND a2.state <> 'verified'
          AND a2.algo_version IS DISTINCT FROM algo_current(a2.op)) THEN
        PERFORM refresh_stale_jobs();
        SELECT * INTO t FROM tile WHERE z = j.z AND x = j.x AND y = j.y;
        p_job := coalesce(live_job(j.z, j.x, j.y, t.expected_version), p_job);
    END IF;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j2 ON j2.id = a2.job_id AND j2.state = 'open'
    INNER JOIN tile t2 ON t2.z = j2.z AND t2.x = j2.x AND t2.y = j2.y
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
      AND j2.target_version = t2.expected_version
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND atom_fits(a2, p_caps)
      AND atom_builds(a2, p_caps)
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

-- ------------------------------------------------- what became of the piece

-- db/0005's heartbeat, saying why when it refuses.
CREATE OR REPLACE FUNCTION heartbeat(p_atom bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid := my_worker(NULL);
    a   atom%rowtype;
BEGIN
    UPDATE atom SET heartbeat_at = now()
    WHERE id = p_atom AND state = 'claimed' AND worker_id = wid;
    IF found THEN
        RETURN;
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom;
    RAISE EXCEPTION 'atom % is not claimed by you: %', p_atom,
        CASE WHEN a.id IS NULL THEN 'there is no such piece'
             WHEN a.state = 'claimed' THEN
                 'another tab holds it since ' || to_char(a.claimed_at, 'HH24:MI:SS')
             WHEN a.state IN ('verified', 'submitted') THEN 'it is already ' || a.state
             ELSE 'it is ' || a.state || ' — the world took it back at '
                  || coalesce(to_char((SELECT max(at) FROM tile_event e
                                       WHERE e.atom_id = a.id), 'HH24:MI:SS'), '?')
        END;
END
$$;

-- ------------------------------------------------------- what this tab is

-- This player's worker as the pool sees it: its trust, and the least it
-- needs to be handed each kind of work (db/0019). Null trust means the tab
-- has never claimed anything.
CREATE FUNCTION my_standing() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT jsonb_build_object(
    'trust', (SELECT min(w.trust) FROM worker w WHERE w.user_id = current_user_id()),
    'needs', jsonb_build_object('train', trust_min('train'), 'verify', trust_min('verify')));
$$;

GRANT EXECUTE ON FUNCTION my_standing() TO player, admin;

CREATE FUNCTION api.my_standing() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_standing()$$;

GRANT EXECUTE ON FUNCTION api.my_standing() TO player, admin;
