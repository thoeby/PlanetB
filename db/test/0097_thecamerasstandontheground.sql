-- Every frame atom of a trained tile is of one version, and every one of them
-- carries the same renderer choice: two tabs handed two chunks of one tile
-- draw it the same way (Invariant 2).
--
-- It used to say frame-v3 and 32 paths a pixel; see db/test/0092.
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land97@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000097'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000097', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18;

SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'frame'),
    ceil(camera_views(18)::numeric / frame_chunk())::bigint,
    'a z18 job has a frame atom per chunk of its camera set');
SELECT is((SELECT count(DISTINCT algo_version) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'frame'), 1::bigint,
    'all of one version');
SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'frame'), 'frame-v10',
    'and that version is the one the client publishes');
SELECT is((SELECT count(DISTINCT params - 'from' - 'to')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'frame'), 1,
    'and they differ in nothing but which views they draw');

SELECT * FROM finish();
ROLLBACK;
