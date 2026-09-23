-- Splats grow in the run rather than after it, over 4000 steps (db/0189).
BEGIN;
SELECT plan(1);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land189@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000189'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000189', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000189');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT (params -> 'brush' ->> 'growth-select-fraction')::numeric FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'), 0.4,
    'brush grows more than its own default (db/0189; its decays went back in db/0190)');

SELECT * FROM finish();
ROLLBACK;
