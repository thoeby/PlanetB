-- 0199_thegroundcanbecutshallower.sql — how deep the ground is cut is a
-- number the world can be built at, like the budget and the frames.
--
-- db/0187 cut a tile's ground from the cuts one or two zooms deeper, over a
-- mesh of up to 2049 vertices across: eight million triangles and a dataset
-- of some two hundred megabytes. That is the world as it should be built, and
-- on a machine with no GPU it is past what one tab can hold — the player-run
-- on four cores and SwiftShader framed for twelve minutes and the tab died.
--
-- So it joins the numbers db/0131 and db/0173 made settable
-- (`splatworld.dem_deeper`, 0 to 2), with the same default as before: by the
-- tile's zoom, one or two deeper. Unset, nothing changes. world_size() says
-- it, like the others, so a world built shallower says so. It travels in the
-- dataset atom's params, so Invariant 2 holds as it did: an atom cut at
-- another depth is another atom.

CREATE OR REPLACE FUNCTION dem_deeper(p_z int) RETURNS int
LANGUAGE sql STABLE AS $$
SELECT least(2, greatest(0, coalesce(
    nullif(current_setting('splatworld.dem_deeper', true), '')::int,
    greatest(1, least(2, 16 - p_z)))));
$$;

GRANT EXECUTE ON FUNCTION dem_deeper(int) TO anon, player, admin;

CREATE OR REPLACE FUNCTION world_default(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_key
    WHEN 'budget_scale' THEN '1'
    WHEN 'iters' THEN '2400'
    WHEN 'frame_px' THEN '1024'
    WHEN 'lease' THEN '00:05:00'
    WHEN 'lease_train' THEN '00:30:00'
    WHEN 'dem_deeper' THEN 'by zoom' END;
$$;

-- db/0173's world_size, with the depth of the ground's cut.
CREATE OR REPLACE FUNCTION world_size() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT jsonb_object_agg(key, jsonb_build_object(
    'is', is_now, 'default', world_default(key), 'set', asked))
FROM (
    SELECT 'budget_scale' AS key, budget_scale()::text AS is_now,
        nullif(current_setting('splatworld.budget_scale', true), '') IS NOT NULL AS asked
    UNION ALL SELECT 'iters', train_iters()::text,
        nullif(current_setting('splatworld.iters', true), '') IS NOT NULL
    UNION ALL SELECT 'frame_px', frame_px()::text,
        nullif(current_setting('splatworld.frame_px', true), '') IS NOT NULL
    UNION ALL SELECT 'lease', claim_patience('assemble')::text,
        nullif(current_setting('splatworld.lease', true), '') IS NOT NULL
    UNION ALL SELECT 'lease_train', claim_patience('train')::text,
        nullif(current_setting('splatworld.lease_train', true), '') IS NOT NULL
            OR nullif(current_setting('splatworld.lease', true), '') IS NOT NULL
    UNION ALL SELECT 'dem_deeper', coalesce(nullif(current_setting('splatworld.dem_deeper',
        true), ''), 'by zoom'),
        nullif(current_setting('splatworld.dem_deeper', true), '') IS NOT NULL
) AS one;
$$;

-- db/0195's build_dag, the ground cut as deep as dem_deeper says.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := camera_set_current(a_z);
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    ds     bigint;
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        -- One tile, one folder: the assembled scene, every frame of the
        -- camera set and the seed, in one piece of work and one tar
        -- (client/atoms/dataset.js). `views` is what the structural rule
        -- holds the frame count to. The ground is cut down to z16.
        ds := new_atom(a_job, 'dataset', 'dataset-v8', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget, 'camera_set', cams, 'size', px,
                               'views', views,
                               'dem_deeper', dem_deeper(a_z),
                               'skirt', 0.01)
            || how, 0, '{}');
        trn := new_atom(a_job, 'train', 'train-v22',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface (db/0184), a tenth of the budget of that on
                -- a lattice across the ground (db/0186), two thirds of the
                -- allocated rest on the ground (db/0174), brush's own growth
                -- window, a refine every 100 steps (db/0188), and more growth
                -- than brush's own (db/0189).
                'seed_share', 0.3,
                'seed_grid', 0.1,
                'ground_floor', 0.66,
                'refine_every', 100,
                'scale', 1,
                'brush', jsonb_build_object(
                    'growth-grad-threshold', 0.0015,
                    'growth-select-fraction', 0.4),
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, ARRAY[ds]);
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

SELECT refresh_stale_jobs();
