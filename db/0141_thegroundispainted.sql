-- 0141_thegroundispainted.sql — the ground a player shaped.
--
-- TASKS-foundation.md FND.9. Until now the only way to move the ground was to
-- draw a `terrainmod` polygon and let the compiler flatten it. A player who
-- wants a road bed along their road, a plateau behind their house and a soft
-- edge between them cannot say that in polygons.
--
-- So a land carries a grid: one float per cell, metres, **relative** to the
-- elevation the operator's DEM says is there. Relative, because the operator
-- can replace the DEM with a better one and what somebody shaped is still what
-- they shaped. The grid is a file like any other (Invariant 1) —
-- `client/lib/r32.js`, kind `height_edit` since db/0127 — and this table is
-- the pointer to the current one.

CREATE TABLE height_edit (
    id       bigserial PRIMARY KEY,
    area_id  uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    sha256   text NOT NULL REFERENCES artifact (sha256),
    rev      bigint NOT NULL,
    saved_by uuid REFERENCES auth.user (id),
    saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX height_edit_area_idx ON height_edit (area_id, rev DESC);

ALTER TABLE height_edit ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON height_edit FOR SELECT USING (true);
-- Invariant 6: shaping a land is building on it, and who may build on it is
-- the world's answer, not the page's.
CREATE POLICY writers ON height_edit FOR ALL TO player, admin
USING (is_area_proposer(area_id)) WITH CHECK (is_area_proposer(area_id));
GRANT SELECT ON height_edit TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON height_edit TO player, admin;
GRANT USAGE, SELECT ON SEQUENCE height_edit_id_seq TO player, admin;

CREATE VIEW api.height_edit WITH (security_invoker = true)
AS SELECT * FROM public.height_edit;
GRANT SELECT ON api.height_edit TO anon, player, admin;

-- The grid a land is shaped by right now: the newest revision of it.
CREATE FUNCTION current_height_edit(p_area uuid) RETURNS height_edit
LANGUAGE sql STABLE AS $$
SELECT * FROM height_edit WHERE area_id = p_area ORDER BY rev DESC LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION current_height_edit(uuid) TO anon, player, admin;

-- ---------------------------------------------------------------- saving one

-- A compare-and-swap on the revision, so two tabs shaping the same land cannot
-- overwrite each other silently, and a trigger's worth of dirtying done here
-- rather than in a trigger: the page says which ground actually moved, and only
-- the tiles that box touches are marked (Invariant 4 — this marks, it builds
-- nothing).
CREATE FUNCTION save_height_edit(p_area uuid, p_sha text, p_rev bigint,
                                 p_bbox jsonb DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid  uuid := current_user_id();
    now_ bigint;
    box  geometry;
    hit  int := 0;
    dep  smallint;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF NOT is_area_proposer(p_area) THEN
        RAISE EXCEPTION 'you can only shape your own land' USING errcode = 'PT403';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = p_sha
                     AND a.kind = 'height_edit') THEN
        RAISE EXCEPTION 'no height_edit artifact %', p_sha USING errcode = 'PT404';
    END IF;
    SELECT coalesce(max(rev), 0) INTO now_ FROM height_edit WHERE area_id = p_area;
    IF coalesce(p_rev, 0) <> now_ THEN
        RAISE EXCEPTION 'this ground was shaped in another tab — reload it'
            USING errcode = 'PT409';
    END IF;

    INSERT INTO height_edit (area_id, sha256, rev, saved_by)
    VALUES (p_area, p_sha, now_ + 1, uid);

    -- What moved: the box the page sends, clipped to the land, or the whole
    -- land when it sends none.
    SELECT detail INTO dep FROM area WHERE id = p_area;
    SELECT st_intersection(a.geom, CASE WHEN p_bbox IS NULL THEN a.geom ELSE
        st_setsrid(st_makeenvelope(
            (p_bbox ->> 0)::double precision, (p_bbox ->> 1)::double precision,
            (p_bbox ->> 2)::double precision, (p_bbox ->> 3)::double precision),
            world_srid()) END)
    INTO box FROM area a WHERE a.id = p_area;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(box, 6, dep) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS hit = ROW_COUNT;

    RETURN jsonb_build_object('rev', now_ + 1, 'tiles', hit);
END
$$;
GRANT EXECUTE ON FUNCTION save_height_edit(uuid, text, bigint, jsonb) TO player, admin;

CREATE FUNCTION api.save_height_edit(area uuid, sha256 text, rev bigint,
                                     bbox jsonb DEFAULT null) RETURNS jsonb
LANGUAGE sql VOLATILE
AS $$SELECT public.save_height_edit(area, sha256, rev, bbox)$$;
GRANT EXECUTE ON FUNCTION api.save_height_edit(uuid, text, bigint, jsonb)
    TO player, admin;

-- --------------------------------------------------------------- the compiler

-- The shaped ground a tile stands on: every land the tile touches that has an
-- edit, with the file and the land's own outline. A land's shaping is the
-- land's own — the compiler is handed the outline and ignores every cell
-- outside it (client/lib/terrain.js), which is the same rule row-level
-- security enforces on the way in.
CREATE FUNCTION height_edits(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'area_id', a.id, 'sha256', e.sha256, 'rev', e.rev,
    'geom', st_asgeojson(a.geom, 12)::jsonb) ORDER BY a.id), '[]'::jsonb)
FROM area a
CROSS JOIN LATERAL current_height_edit(a.id) e
WHERE e.sha256 IS NOT NULL
  AND st_intersects(a.geom, tile_bbox(z, x, y));
$$;
GRANT EXECUTE ON FUNCTION height_edits(int, int, int) TO anon, player, admin;

-- Invariant 2: what a tile was built from includes the ground it was built on.
-- A land shaped after the atom was made moves the snapshot, and the atom
-- cannot publish over it.
CREATE OR REPLACE FUNCTION world_snapshot(z int, x int, y int) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
SELECT encode(public.digest(
    coalesce(string_agg(sig, ',' ORDER BY sig), '') || E'\nstyle:'
    || coalesce((SELECT max(id) FROM style_version), 0)::text
    || E'\nground:' || coalesce((
        SELECT string_agg(e ->> 'sha256', ',' ORDER BY e ->> 'area_id')
        FROM jsonb_array_elements(height_edits(z, x, y)) e), ''),
    'sha256'), 'hex')
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

-- db/0139's tile_world, carrying the shaped ground with the rest of it.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'symbols', pinned_symbols(),
    'symbol_files', symbol_files(),
    'height_edits', height_edits(z, x, y),
    'features', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'kind', f.kind, 'rev', f.rev, 'props', f.props,
            'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id)
        FROM feature f
        WHERE f.deleted_at IS NULL
          AND st_intersects(f.geom, tile_bbox(z, x, y))), '[]'::jsonb),
    'instances', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'san', i.san, 'rev', i.rev, 'props', i.props,
            'sha256', a.sha256, 'canon_version', a.canon_version, 'parts', a.parts,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

-- db/0070's geo_inputs, pinning the shaped ground by hash so the atom's inputs
-- name every file it read (Invariant 2). The tile the elevation was cut for
-- stays one string: an atom's inputs say a number means another atom of this
-- job (client/js/inputs.js), which db/0070 paid for the expensive way.
CREATE OR REPLACE FUNCTION geo_inputs(p_z int, p_x int, p_y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(
    (SELECT jsonb_build_object('dem', g.sha256,
                               'dem_at', g.z || '/' || g.x || '/' || g.y)
     FROM geo_tile g
     WHERE g.z <= p_z
       AND g.x = p_x / (1 << (p_z - g.z))
       AND g.y = p_y / (1 << (p_z - g.z))
     ORDER BY g.z DESC
     LIMIT 1),
    '{}'::jsonb)
|| jsonb_build_object('ground', coalesce((
    SELECT jsonb_agg(e -> 'sha256' ORDER BY e ->> 'area_id')
    FROM jsonb_array_elements(height_edits(p_z, p_x, p_y)) e), '[]'::jsonb));
$$;

-- ------------------------------------------------------------------ the store

-- db/0138's can_write, with the extension a shaped ground is written under.
CREATE OR REPLACE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    wid   uuid;
    m     text [];
    known boolean;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF can_write.sha256 IS NULL OR can_write.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a valid sha256 must be declared' USING errcode = 'PT403';
    END IF;
    known := EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = can_write.sha256);

    SELECT id INTO wid FROM worker WHERE user_id = uid;

    m := regexp_match(path, '^/jobs/([0-9]+)/[A-Za-z0-9._-]+$');
    IF m IS NOT NULL THEN
        IF known THEN
            RAISE EXCEPTION 'artifact already registered' USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom
                   WHERE id = m[1]::bigint AND state = 'claimed'
                     AND worker_id = wid) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'atom % is not claimed by you', m[1] USING errcode = 'PT403';
    END IF;

    m := regexp_match(path, '^/assets/([0-9a-f]{64})\.(glb|webp|elx|png|json|r32)$');
    IF m IS NOT NULL THEN
        IF m[1] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        RETURN;
    END IF;

    m := regexp_match(path,
        '^/tiles/([0-9]+)/([0-9]+)/([0-9]+)/([0-9a-f]{64})\.(sog|r16|json)$');
    IF m IS NOT NULL THEN
        IF m[4] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom a
                   JOIN job j ON j.id = a.job_id
                   WHERE a.op = 'sog' AND a.worker_id = wid
                     AND a.state IN ('claimed', 'submitted', 'verified')
                     AND j.z = m[1]::int AND j.x = m[2]::int AND j.y = m[3]::int) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'you hold no sog atom for %/%/%', m[1], m[2], m[3]
            USING errcode = 'PT403';
    END IF;

    RAISE EXCEPTION 'path % is not writable', path USING errcode = 'PT403';
END
$$;

-- db/0140's build_dag, with assemble at `assemble-v7`.
--
-- Invariant 2: the atom shapes the ground before it builds anything on it, and
-- a worker running the old code would put the road back on the bare DEM.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v2' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    chunk  int := frame_chunk();
    i      int;
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v7', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v10',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v7',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                'seed_share', 0.0375,
                'scale', 3,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

-- db/0136's submission_changes, saying whether the ground itself moved. An
-- approver looking at a submission with no objects and no features in it was
-- being shown nothing at all.
CREATE OR REPLACE FUNCTION submission_changes(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.dirty AND t.expected_version > 0
                AND is_leaf_tile(t.z, t.x, t.y)
                AND st_intersects((SELECT geom FROM area WHERE id = p_area),
                                  tile_bbox(t.z, t.x, t.y))),
    'objects', (SELECT count(*) FROM instance i
                WHERE i.area_id = p_area AND i.deleted_at IS null),
    'moved', (SELECT count(*) FROM instance i
              WHERE i.area_id = p_area AND i.deleted_at IS null AND i.rev > 1),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = p_area AND f.deleted_at IS null),
    'ground', coalesce((SELECT rev FROM current_height_edit(p_area)), 0),
    'kinds', coalesce((
        SELECT jsonb_object_agg(k.kind, k.n) FROM (
            SELECT f.kind, count(*) AS n FROM feature f
            WHERE f.area_id = p_area AND f.deleted_at IS null
            GROUP BY f.kind) k), '{}'::jsonb));
$$;

-- The lines drawn on a land, so a bed can be laid along one without clicking
-- it out by hand. A geometry column comes back from PostgREST as the bytes it
-- is stored as; every other reader of geometry in this world gets GeoJSON
-- (tile_world), and so does this one.
CREATE FUNCTION area_lines(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'kind', f.kind, 'props', f.props,
    'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id), '[]'::jsonb)
FROM feature f
WHERE f.area_id = p_area AND f.deleted_at IS NULL
  AND st_geometrytype(f.geom) IN ('ST_LineString', 'ST_MultiLineString');
$$;
GRANT EXECUTE ON FUNCTION area_lines(uuid) TO anon, player, admin;

CREATE FUNCTION api.area_lines(area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_lines(area)$$;
GRANT EXECUTE ON FUNCTION api.area_lines(uuid) TO anon, player, admin;

-- What revision a land's shaping is at, so a save from outside the page can
-- name the one it is replacing (the compare-and-swap above). Reading is
-- public in this world; saving is not.
CREATE FUNCTION height_edit_rev(p_area uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
SELECT coalesce((SELECT rev FROM current_height_edit(p_area)), 0);
$$;
GRANT EXECUTE ON FUNCTION height_edit_rev(uuid) TO anon, player, admin;

CREATE FUNCTION api.height_edit_rev(area uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$SELECT public.height_edit_rev(area)$$;
GRANT EXECUTE ON FUNCTION api.height_edit_rev(uuid) TO anon, player, admin;
