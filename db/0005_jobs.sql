-- 0005_jobs.sql — jobs, the atom DAG and the claim/submit state machine.
-- Invariant 4: nothing here is called by a trigger or a cron. Jobs exist only
-- because a client asked for one; claims expire only when another client claims.

-- Structural checks are data, not code: one boolean SQL expression per rule.
-- $1 = the atom row, $2 = the submitted result jsonb, $3 = output bytes.
CREATE TABLE structural_rule (
    op   text NOT NULL,
    name text NOT NULL,
    rule text NOT NULL,
    PRIMARY KEY (op, name)
);
ALTER TABLE structural_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON structural_rule FOR SELECT USING (true);
GRANT SELECT ON structural_rule TO anon, player, admin;

INSERT INTO structural_rule (op, name, rule) VALUES
('assemble', 'bytes', '$3 > 0'),
('frame', 'bytes', '$3 > 0'),
('train', 'bytes', '$3 > 0'),
('merge', 'bytes', '$3 > 0'),
('sog', 'bytes', '$3 > 0'),
('verify', 'bytes', 'true'),
('train', 'budget',
 'coalesce(($2->>''splat_count'')::bigint, 0) <= (($1).params->>''budget'')::bigint'),
('merge', 'budget',
 'coalesce(($2->>''splat_count'')::bigint, 0) <= (($1).params->>''budget'')::bigint'),
('sog', 'budget',
 'coalesce(($2->>''splat_count'')::bigint, 0) <= (($1).params->>''budget'')::bigint');

-- --------------------------------------------------------------- parameters

-- Splat budgets per zoom (ARCHITECTURE §2).
CREATE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z
    WHEN 18 THEN 2000000 WHEN 16 THEN 600000 WHEN 14 THEN 800000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END::bigint;
$$;

-- Camera sets: z18-v1 = 3 rings x 24 az + 4 street loops x 10 + 8 top-down,
-- z16-v1 = 2 rings x 24 az + 8 top-down.
CREATE FUNCTION camera_views(z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z WHEN 18 THEN 120 WHEN 16 THEN 56 ELSE 0 END;
$$;

-- Open decision 2: one frame atom renders 20 views.
CREATE FUNCTION frame_chunk() RETURNS int LANGUAGE sql IMMUTABLE AS $$SELECT 20$$;

-- ------------------------------------------------------------------ hashing

-- Invariant 2. jsonb renders canonically (object keys sorted, no whitespace),
-- and every array below is built in sorted order, so equal computations hash
-- equal on any server.
CREATE FUNCTION atom_hash(op text, algo_version text, inputs jsonb,
                          params jsonb, seed int) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT encode(public.digest(
    op || E'\n' || algo_version || E'\n' || inputs::text || E'\n'
    || params::text || E'\n' || seed::text, 'sha256'), 'hex');
$$;

-- The world as this tile sees it: every live feature and instance that touches
-- it, pinned at its current rev.
CREATE FUNCTION world_snapshot(z int, x int, y int) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
SELECT encode(public.digest(
    coalesce(string_agg(sig, ',' ORDER BY sig), ''), 'sha256'), 'hex')
FROM (
    SELECT f.id::text || ':' || f.rev::text AS sig
    FROM feature f
    WHERE f.deleted_at IS NULL
      AND st_intersects(f.geom, tile_bbox(z, x, y))
    UNION ALL
    SELECT i.id::text || ':' || i.rev::text
    FROM instance i
    WHERE i.deleted_at IS NULL
      AND st_intersects(i.geom, tile_bbox(z, x, y))
) s;
$$;

-- Published .sog of the 16 grandchildren at z+2, sorted; a missing child is
-- recorded as null so the hash still pins the exact set that was merged.
CREATE FUNCTION child_sogs(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s), '[]'::jsonb)
FROM (
    SELECT coalesce(
        (SELECT t.sog_sha256 FROM tile t
         WHERE t.z = z + 2 AND t.x = x * 4 + dx AND t.y = y * 4 + dy),
        '') AS s
    FROM generate_series(0, 3) dx, generate_series(0, 3) dy
) c;
$$;

CREATE FUNCTION instance_glbs(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(a.sha256)), '[]'::jsonb)
FROM instance i
JOIN asset a ON a.san = i.san
WHERE i.deleted_at IS NULL AND st_intersects(i.geom, tile_bbox(z, x, y));
$$;

-- ------------------------------------------------------------- DAG building

CREATE FUNCTION new_atom(a_job bigint, a_op text, a_algo text, a_inputs jsonb,
                         a_params jsonb, a_seed int, a_deps bigint [])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    h   text := atom_hash(a_op, a_algo, a_inputs, a_params, a_seed);
    aid bigint;
BEGIN
    INSERT INTO atom (job_id, atom_hash, op, algo_version, deps, inputs,
                      params, seed, state)
    VALUES (a_job, h, a_op, a_algo, a_deps, a_inputs, a_params, a_seed,
            CASE WHEN cardinality(a_deps) = 0 THEN 'ready' ELSE 'waiting' END)
    ON CONFLICT (atom_hash) DO NOTHING
    RETURNING id INTO aid;
    IF aid IS NULL THEN
        -- Identical computation already exists; reuse it rather than repeat it.
        SELECT id INTO aid FROM atom WHERE atom_hash = h;
    END IF;
    RETURN aid;
END
$$;

CREATE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap      text := world_snapshot(a_z, a_x, a_y);
    base      jsonb;
    asm       bigint;
    frames    bigint [] := '{}';
    trn       bigint;
    sg        bigint;
    mrg       bigint;
    views     int := camera_views(a_z);
    chunk     int := frame_chunk();
    i         int;
    budget    bigint := tile_budget(a_z);
BEGIN
    IF a_z >= 16 THEN
        -- Geo inputs are immutable per seed version (ARCHITECTURE §7); WP2.1
        -- registers them as artifacts and can swap coords for hashes here.
        base := jsonb_build_object(
            'snapshot', snap,
            'geo_seed', coalesce(current_setting('app.geo_seed', true), 'v1'),
            'glb', instance_glbs(a_z, a_x, a_y));
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set',
                        CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END,
                    'from', i, 'to', least(i + chunk, views)), 0,
                ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        sg := new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
        FOR i IN 1..3 LOOP
            PERFORM new_atom(a_job, 'verify', 'verify-v1',
                jsonb_build_object('sog', sg),
                jsonb_build_object('index', i, 'min_psnr', 22), 0, ARRAY[sg]);
        END LOOP;
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

-- ---------------------------------------------------------------- ensure_job

CREATE FUNCTION ensure_job(z int, x int, y int, bounty numeric DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t   tile%rowtype;
    jid bigint;
BEGIN
    SELECT * INTO t FROM tile
    WHERE tile.z = ensure_job.z AND tile.x = ensure_job.x AND tile.y = ensure_job.y;
    IF t.z IS NULL THEN
        RAISE EXCEPTION 'no such tile %/%/%', z, x, y;
    END IF;
    IF t.expected_version = 0 THEN
        RAISE EXCEPTION 'tile %/%/% has no world input yet', z, x, y;
    END IF;

    -- Either you may edit something inside the tile, or you pay for the work.
    IF bounty <= 0
       AND current_user_role() <> 'admin'
       AND NOT EXISTS (
           SELECT 1 FROM area
           WHERE st_intersects(area.geom, tile_bbox(z, x, y))
             AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'not authorised for %/%/% and no bounty attached', z, x, y;
    END IF;

    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version;
    IF jid IS NOT NULL THEN
        RETURN jid;
    END IF;

    -- A newer snapshot exists, so anything still open is compiling stale input.
    UPDATE job SET state = 'cancelled'
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.state = 'open' AND job.target_version < t.expected_version;

    INSERT INTO job (z, x, y, target_version, bounty)
    VALUES (z, x, y, t.expected_version, greatest(bounty, 0))
    RETURNING id INTO jid;

    PERFORM build_dag(jid, z, x, y);
    RETURN jid;
END
$$;
