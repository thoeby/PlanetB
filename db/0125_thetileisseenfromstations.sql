-- 0125_thetileisseenfromstations.sql — the frames cover the tile, the void is
-- not painted, and the ground is drawn at the survey's own grid.
--
-- What the frames the trainer learns from looked like, from one set: two
-- rings of 24 cameras all looking at the middle of the tile from 570 m out,
-- and eight top-downs from 1.4 km. The corners of a 1.7 km tile were at the
-- edge of every frame or past it; the same ground was seen 48 times from the
-- same distance at two pitches; every oblique and every top-down saw past the
-- tile's edge into a void painted sky-blue, which the trainer learned as a
-- blue wall; and across every frame, a grid — the terrain mesh at one colour
-- and one normal per 6.6 m vertex, every cell edge a line. Three changes, one
-- job:
--
--   z16-v2   nine stations in a grid across the tile, each seen straight
--            down from high enough that the footprints overlap by half and
--            from four sides at 55° from close (client/lib/cameras.js). 45
--            views. The overlap and the parallax photogrammetry wants.
--   frame-v10  the void is transparent, not sky; train-v7 tells brush the
--            alpha is a mask, so those pixels are nobody's (client/lib/raster.js,
--            client/lib/brush.js).
--   assemble-v5  the ground read at 513 vertices from a tile the server now
--            cuts at 512 samples (server/splatworld/importer.py DEM_SIZE):
--            3.3 m a cell at z14 instead of 6.6, four times the triangles,
--            and the grid pitch halved on the way to a texture.
--
-- Every algo_version that changed its bytes changed its name (Invariant 2),
-- so every tile is built again from the ground up. z18 keeps z18-v1 for now.
CREATE OR REPLACE FUNCTION camera_views(z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z WHEN 18 THEN 120 WHEN 16 THEN 45 WHEN 14 THEN 45 ELSE 0 END;
$$;

-- db/0124's build_dag, with the three versions and the set.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v2' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
    px     int := 1024;
    how    jsonb := frame_renderer();
BEGIN
    IF a_z >= 14 THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v5', base,
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
                'iters', 1200,
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.125,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them.
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
