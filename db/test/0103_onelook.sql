-- The atoms a job is built with: one dataset version and one training run,
-- whatever the zoom. db/0103_onelook.sql settled that the light is baked once
-- and drawn as it is; what has moved since are the version names (the assemble
-- and the frames are one dataset atom, db/0183), the iteration count
-- (db/0114), and the sampler, which is gone — a z14 tile is trained like the
-- rest.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land103@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000103'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
-- A fine tile is earned by something standing on it (db/0089), so there is
-- something on it, and then the land asks for the detail.
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000103', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT set_area_detail('00000000-0000-0000-0000-000000000103', 18);
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18,
       ensure_job(16, tile_x(7.805, 16), tile_y(46.295, 16)) AS j16,
       ensure_job(14, tile_x(7.805, 14), tile_y(46.295, 14)) AS j14;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'dataset'), 'dataset-v8',
    'the dataset bakes the light and draws it as it is');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op IN ('assemble', 'frame')), 0,
    'and nothing else assembles or draws it');
SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'train'), 2400,
    'z18: 2400 iterations');
-- z16 and z14 both have finer tiles under them on this land, so they are
-- merged from what is there rather than rendering the same ground again
-- (db/0135). The look they carry is their children's.
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT j16 FROM jobs) AND op = 'merge'), 1,
    'z16: merged from the z18 under it');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT j14 FROM jobs) AND op = 'merge'), 1,
    'z14: merged from the z16 under it');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT j14 FROM jobs)
             AND op IN ('dataset', 'assemble', 'frame', 'train')), 0,
    'and neither assembles a hillside its children already carry');

SELECT * FROM finish();
ROLLBACK;
