-- "Compile it all again" withdraws what was submitted for the version it
-- moves past, so the land is submittable again at once; and frames are v4.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land99@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000099'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000099', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE sub AS
SELECT submit_area('00000000-0000-0000-0000-000000000099', 'first') AS sid;
SELECT is((SELECT state FROM submission WHERE id = (SELECT sid FROM sub)), 'open',
    'the land is submitted and awaiting approval');
SELECT is((area_progress('00000000-0000-0000-0000-000000000099') ->> 'to_submit')::int, 0,
    'nothing left to submit while it waits');

SELECT ok(recompile_land('00000000-0000-0000-0000-000000000099') > 0, 'compile it all again');
SELECT is((SELECT state FROM submission WHERE id = (SELECT sid FROM sub)), 'withdrawn',
    'the old submission is withdrawn, not left awaiting approval');
SELECT ok((area_progress('00000000-0000-0000-0000-000000000099') ->> 'to_submit')::int > 0,
    'and every tile of the land is to submit again');

-- The frames a trained tile is built from.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000991'::uuid,
       st_geomfromtext('POLYGON((7.9 46.29,7.91 46.29,7.91 46.30,7.9 46.30,7.9 46.29))',
                       4326),
       ids.owner_id, 16
FROM ids;
CREATE TEMP TABLE j16 AS
SELECT ensure_job(16, tile_x(7.905, 16), tile_y(46.295, 16)) AS jid;
SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT jid FROM j16) AND op = 'frame'), 'frame-v4',
    'frames are frame-v4');
SELECT is((SELECT min((params ->> 'size')::int) FROM atom
           WHERE job_id = (SELECT jid FROM j16) AND op IN ('frame', 'train')), 1024,
    'a z16 tile is framed and trained at 1024 px');

SELECT * FROM finish();
ROLLBACK;
