-- 0039_ground.sql — the ground the world stands on.
--
-- One world on one DEM (TASKS-usable.md). The ground is a coverage published by
-- the operator's GeoServer: where it has data there is world, and nowhere else.
-- This holds which coverage that is and how far it reaches, so the viewer can
-- say "you have walked off the edge" and the compiler can pin the exact
-- elevation bytes a tile was built from.
--
-- Nothing here fetches anything. The server cuts a tile from the coverage when
-- a browser asks for one and records it in geo_tile; this is where that record
-- lives and how it reaches an atom's inputs (Invariant 2).

-- ------------------------------------------------------------------ ground

-- One row, ever. `only_one` makes that a constraint rather than a convention.
CREATE TABLE ground (
    only_one      boolean PRIMARY KEY DEFAULT true CHECK (only_one),
    geoserver_url text NOT NULL,
    coverage      text NOT NULL,
    -- The coverage's extent in lon/lat. Outside it there is no world.
    extent        geometry(Polygon, 4326) NOT NULL,
    set_at        timestamptz NOT NULL DEFAULT now(),
    set_by        uuid
);
-- Every geometry column is GiST-indexed (db/test/0001_schema.sql asserts it).
CREATE INDEX ground_extent_idx ON ground USING gist (extent);
ALTER TABLE ground ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON ground FOR SELECT USING (true);
GRANT SELECT ON ground TO anon, player, admin;

-- What the viewer needs before it can show anything: where the world is. Public,
-- because a visitor who has not signed in still gets to look at it.
CREATE FUNCTION ground_view() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce((
    SELECT jsonb_build_object(
        'coverage', g.coverage,
        'geoserver_url', g.geoserver_url,
        'set_at', g.set_at,
        'west', st_xmin(g.extent), 'south', st_ymin(g.extent),
        'east', st_xmax(g.extent), 'north', st_ymax(g.extent),
        'centre', jsonb_build_object(
            'lon', st_x(st_centroid(g.extent)), 'lat', st_y(st_centroid(g.extent))))
    FROM ground g), '{}'::jsonb);
$$;
GRANT EXECUTE ON FUNCTION ground_view() TO anon, player, admin;

-- Choosing the ground is an install-time act: whoever is setting the world up
-- does it, and after that it takes an admin. Changing it invalidates every tile
-- already compiled over it — the elevation under them has changed — but it does
-- not materialise new ones: a tile exists because somebody drew something
-- there, which is still the only reason (Invariant 4).
CREATE FUNCTION set_ground(p_url text, p_coverage text,
                           p_west double precision, p_south double precision,
                           p_east double precision, p_north double precision)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    box   geometry;
    n     int := 0;
    first boolean := NOT EXISTS (SELECT 1 FROM ground);
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT first AND current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin moves the world' USING errcode = '42501';
    END IF;
    IF p_west >= p_east OR p_south >= p_north THEN
        RAISE EXCEPTION 'that coverage has no extent';
    END IF;
    box := st_makeenvelope(greatest(p_west, -180), greatest(p_south, -85.06),
                           least(p_east, 180), least(p_north, 85.06), 4326);

    INSERT INTO ground (only_one, geoserver_url, coverage, extent, set_by)
    VALUES (true, p_url, p_coverage, box, uid)
    ON CONFLICT (only_one) DO UPDATE
    SET geoserver_url = excluded.geoserver_url, coverage = excluded.coverage,
        extent = excluded.extent, set_at = now(), set_by = excluded.set_by;

    -- New elevation under a tile that has already been compiled means that tile
    -- is wrong. Only tiles that exist are touched.
    UPDATE tile t SET dirty = true, expected_version = t.expected_version + 1
    WHERE t.expected_version > 0 AND st_intersects(tile_bbox(t.z, t.x, t.y), box);
    GET DIAGNOSTICS n = ROW_COUNT;
    -- The cut tiles were cut from the old coverage.
    DELETE FROM geo_tile;
    RETURN jsonb_build_object('dirtied', n, 'first', first);
END
$$;

-- --------------------------------------------------------------- geo tiles

-- The elevation actually handed to a compile, one row per tile, content
-- addressed like everything else. The server writes these when it cuts a tile;
-- nothing else does, which is why there is no client grant.
CREATE TABLE geo_tile (
    z       zoom NOT NULL,
    x       int NOT NULL CHECK (x >= 0),
    y       int NOT NULL CHECK (y >= 0),
    sha256  text NOT NULL REFERENCES artifact (sha256),
    cut_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (z, x, y),
    CHECK (x < (1 << z) AND y < (1 << z))
);
ALTER TABLE geo_tile ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON geo_tile FOR SELECT USING (true);
GRANT SELECT ON geo_tile TO anon, player, admin;

-- The elevation a tile's atoms must read, by sha, falling back to the coarsest
-- cut that covers it — Web-Mercator tiles nest exactly, so a z10 cut can be
-- sampled for a z14 tile (client/lib/geo.js already does). This is what pins
-- the ground into the atom hash, in place of the `geo_seed` string build_dag
-- used to carry (Invariant 2).
CREATE FUNCTION geo_inputs(p_z int, p_x int, p_y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(
    (SELECT jsonb_build_object('dem', g.sha256, 'dem_z', g.z, 'dem_x', g.x,
                               'dem_y', g.y)
     FROM geo_tile g
     WHERE g.z <= p_z
       AND g.x = p_x / (1 << (p_z - g.z))
       AND g.y = p_y / (1 << (p_z - g.z))
     ORDER BY g.z DESC
     LIMIT 1),
    '{}'::jsonb);
$$;
GRANT EXECUTE ON FUNCTION geo_inputs(int, int, int) TO anon, player, admin;

-- ------------------------------------------------------------------ the dag
--
-- db/0017_verifydag.sql's — the newest of the five that have redefined this
-- function — with one line changed: the ground is pinned by hash instead of by
-- the name of a seed run. Rebuilding it from an older copy is how a later fix
-- gets silently reverted, which is exactly what happened on the first attempt
-- at this migration and what db/test/0017_verify.sql caught.

CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
BEGIN
    IF a_z >= 14 THEN
        -- The ground by hash, not by the name of a seed run: the elevation a
        -- tile was compiled from is part of what that compile was (Invariant 2).
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget, 'camera_set', cams,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        smp := new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
        FOR i IN 1..verify_count(trn) LOOP
            PERFORM new_atom(a_job, 'verify', 'verify-v1',
                jsonb_build_object('sog', smp, 'frames', to_jsonb(frames)),
                jsonb_build_object('index', i, 'min_psnr', 22, 'camera_set', cams,
                                   'require_distinct_workers', true), 0, ARRAY[smp]);
        END LOOP;
    ELSIF a_z = 14 THEN
        smp := new_atom(a_job, 'sample', 'sample-v1',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
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

-- ------------------------------------------------------------- first admin
--
-- Somebody has to be able to set the world up and define its properties, and on
-- a fresh install there is nobody. The first account made is that person; every
-- one after it is a player, and only an admin can change that.

CREATE OR REPLACE FUNCTION register(email text, pw text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid   uuid;
    first boolean := NOT EXISTS (SELECT 1 FROM auth.user);
BEGIN
    IF length(pw) < 8 THEN
        RAISE EXCEPTION 'password must be at least 8 characters';
    END IF;
    INSERT INTO auth.user (email, pw_hash, role)
    VALUES (lower(register.email), public.crypt(register.pw, public.gen_salt('bf')),
            CASE WHEN first THEN 'admin' ELSE 'player' END)
    RETURNING id INTO uid;
    INSERT INTO account (owner_id) VALUES (uid);
    RETURN uid;
END
$$;

GRANT EXECUTE ON FUNCTION set_ground(text, text, double precision,
    double precision, double precision, double precision) TO player, admin;

CREATE FUNCTION api.ground() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.ground_view()$$;
GRANT EXECUTE ON FUNCTION api.ground() TO anon, player, admin;

CREATE FUNCTION api.set_ground(url text, coverage text,
                               west double precision, south double precision,
                               east double precision, north double precision)
RETURNS jsonb LANGUAGE sql
AS $$SELECT public.set_ground(url, coverage, west, south, east, north)$$;
GRANT EXECUTE ON FUNCTION api.set_ground(text, text, double precision,
    double precision, double precision, double precision) TO player, admin;

CREATE FUNCTION api.geo_inputs(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.geo_inputs(z, x, y)$$;
GRANT EXECUTE ON FUNCTION api.geo_inputs(int, int, int) TO anon, player, admin;

CREATE VIEW api.ground_row WITH (security_invoker = true) AS
SELECT * FROM public.ground;
GRANT SELECT ON api.ground_row TO anon, player, admin;

CREATE VIEW api.geo_tile WITH (security_invoker = true) AS
SELECT * FROM public.geo_tile;
GRANT SELECT ON api.geo_tile TO anon, player, admin;
