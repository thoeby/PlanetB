-- 0140_astyleisappliedonpurpose.sql — a symbol reaches the world when somebody
-- says so.
--
-- TASKS-foundation.md FND.8. db/0139 made a rule a symbol and pinned the ones
-- the world is built with in a `style_version`. Saving a symbol writes a new
-- version of it and nothing else: every published tile still says what it said,
-- because it was built with the applied style and the applied style has not
-- moved. This is the moment it moves.
--
-- Invariant 4 still holds: nothing here computes anything about the world. It
-- marks tiles dirty and opens jobs through `ensure_job`, and some player's tab
-- does the work.

-- Why a job is in the pool. Everything before this was somebody's own edit;
-- a rebuild nobody asked for by name needs to say where it came from.
ALTER TABLE job ADD COLUMN reason text;

-- ------------------------------------------------------- what has changed

-- Which symbols are not what the world is built with, and how much of the
-- world each of them is in.
--
-- "Is in" is read by kind, not by filter: whether a symbol's conditions hold
-- for a feature is client/lib/rules.js's question and it is answered in a tab
-- (Invariant 9). So this over-counts — a tile with a `highway` in it is
-- counted for every changed highway symbol — and it says a number nobody is
-- charged for. What it must never do is under-count, and it does not.
CREATE FUNCTION style_changes() RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH pinned AS (
    SELECT coalesce((SELECT p.symbols FROM style_version p
                     WHERE p.id = (SELECT max(id) FROM style_version)),
                    '{}'::jsonb) AS at
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'kind', c.kind,
    'version', c.version, 'applied', c.applied,
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.published_version > 0
                AND EXISTS (SELECT 1 FROM feature f
                            WHERE f.deleted_at IS NULL AND f.kind = c.kind
                              AND st_intersects(f.geom, tile_bbox(t.z, t.x, t.y)))))
    ORDER BY c.kind, c.name), '[]'::jsonb)
FROM (
    SELECT s.id, s.name, s.kind, s.version,
        (SELECT (at ->> s.id::text)::int FROM pinned) AS applied
    FROM symbol s WHERE s.enabled
) c
WHERE c.applied IS DISTINCT FROM c.version;
$$;
GRANT EXECUTE ON FUNCTION style_changes() TO anon, player, admin;

CREATE FUNCTION api.style_changes() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.style_changes()$$;
GRANT EXECUTE ON FUNCTION api.style_changes() TO anon, player, admin;

-- ------------------------------------------------------------- applying it

-- The tiles a changed symbol is in: published ones holding a feature of its
-- kind. A tile nobody has published has nothing to rebuild.
CREATE FUNCTION tiles_for_styles(p_kinds text []) RETURNS TABLE (z int, x int, y int)
LANGUAGE sql STABLE AS $$
SELECT t.z::int, t.x, t.y FROM tile t
WHERE t.published_version > 0
  AND EXISTS (SELECT 1 FROM feature f
              WHERE f.deleted_at IS NULL AND f.kind = ANY (p_kinds)
                AND st_intersects(f.geom, tile_bbox(t.z, t.x, t.y)))
ORDER BY t.z, t.x, t.y;
$$;
GRANT EXECUTE ON FUNCTION tiles_for_styles(text []) TO admin;

-- Admin only (Invariant 6). One transaction: the style is pinned, the tiles it
-- changed are marked, and a job is opened for each through `ensure_job` — at
-- the back of the pool, because a rebuild nobody asked for carries no bounty
-- and `render_pool` sorts by bounty first (db/0132).
--
-- Every job already in flight is moved too, and that is not a nicety: a tile's
-- snapshot names the applied style (db/0139), so an atom built a minute ago
-- can no longer publish whatever tile it is about (Invariant 2). A job left at
-- the old version would sit in the pool failing with "the world moved".
CREATE FUNCTION apply_styles(p_note text DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    changed jsonb := style_changes();
    kinds   text [];
    sid     int;
    t       record;
    jid     bigint;
    n       int := 0;
BEGIN
    PERFORM require_admin();
    IF jsonb_array_length(changed) = 0 THEN
        RETURN jsonb_build_object('style_version', (SELECT max(id) FROM style_version),
            'symbols', 0, 'tiles', 0);
    END IF;
    SELECT array_agg(DISTINCT c ->> 'kind') INTO kinds
    FROM jsonb_array_elements(changed) c;

    INSERT INTO style_version (symbols, note, applied_by)
    SELECT coalesce(jsonb_object_agg(s.id::text, s.version), '{}'::jsonb),
        p_note, current_user_id()
    FROM symbol s WHERE s.enabled
    RETURNING id INTO sid;

    -- Invariant 4: mark dirty, then ask for the job. The version bump is what
    -- makes a worker mid-flight unable to publish over the rebuild
    -- (Invariant 3). The union is read whole before the first tile moves.
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR t IN
        WITH styled AS MATERIALIZED (SELECT * FROM tiles_for_styles(kinds)),
        inflight AS MATERIALIZED (
            SELECT j.z::int AS z, j.x, j.y FROM job j
            INNER JOIN tile ti ON ti.z = j.z AND ti.x = j.x AND ti.y = j.y
            WHERE j.state = 'open' AND j.target_version = ti.expected_version)
        SELECT z, x, y FROM styled
        UNION
        SELECT z, x, y FROM inflight
    LOOP
        UPDATE tile SET dirty = true, expected_version = expected_version + 1
        WHERE tile.z = t.z AND tile.x = t.x AND tile.y = t.y;
        -- Asked for first and named afterwards: `ensure_job` is volatile, and
        -- in a WHERE clause Postgres calls it once per row it looks at.
        jid := ensure_job(t.z, t.x, t.y);
        UPDATE job SET reason = 'style update' WHERE id = jid;
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);

    RETURN jsonb_build_object('style_version', sid,
        'symbols', jsonb_array_length(changed), 'tiles', n);
END
$$;
GRANT EXECUTE ON FUNCTION apply_styles(text) TO admin;

CREATE FUNCTION api.apply_styles(note text DEFAULT null) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.apply_styles(note)$$;
GRANT EXECUTE ON FUNCTION api.apply_styles(text) TO admin;

-- ------------------------------------------------------------- the pool

-- db/0132's render_pool, saying why a job is there. Everything else about it
-- is unchanged.
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM expire_claims();
    RETURN (
    SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
    FROM (
        SELECT jsonb_build_object(
            'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
            'bounty', job.bounty, 'version', job.target_version,
            'opened_at', job.created_at, 'why', job.reason,
            'ready', (SELECT count(*) FROM atom a
                      WHERE a.job_id = job.id AND a.state = 'ready'),
            'blocked', (SELECT count(*) FROM atom a
                        WHERE a.job_id = job.id AND a.state = 'waiting'),
            'claimed', (SELECT count(*) FROM atom a
                        WHERE a.job_id = job.id AND a.state = 'claimed'),
            'failed', (SELECT count(*) FROM atom a
                       WHERE a.job_id = job.id AND a.state = 'failed'),
            'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                            WHERE a.job_id = job.id),
            'may_retry', may_retry_job(job.id),
            'made', CASE
                WHEN EXISTS (SELECT 1 FROM atom a
                             WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
                WHEN EXISTS (SELECT 1 FROM atom a
                             WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
                ELSE 'merged from its children' END,
            'needs_webgpu', EXISTS (
                SELECT 1 FROM atom a WHERE a.job_id = job.id AND a.state = 'ready'
                  AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
            'needs_mb', (SELECT coalesce(max(atom_buffer_mb(a)), 0) FROM atom a
                         WHERE a.job_id = job.id AND a.state = 'ready'),
            'metres', CASE WHEN p_lon IS null THEN null ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
            'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
                || lpad(coalesce(CASE WHEN p_lon IS null THEN 0 ELSE
                    st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                                st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                    END, 0)::bigint::text, 12, '0')
                || lpad((18 - job.z)::text, 2, '0'))
            || sibling_tiles(job.z, job.x, job.y) AS j
        FROM job
        INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
        WHERE job.state = 'open'
          AND job.target_version = t.expected_version
          AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                      AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
          AND NOT EXISTS (SELECT 1 FROM atom a
                          WHERE a.job_id = job.id AND a.op = 'merge'
                            AND a.state IN ('ready', 'waiting')
                            AND NOT merge_has_a_child(a.inputs))
        ORDER BY job.bounty DESC, job.id
        LIMIT greatest(p_limit, 0)
    ) pool
    );
END
$$;
