-- The sog atom a job is built with, and the kind of file a tile's levels are.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land134@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000134'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))', 4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000134', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18,
       ensure_job(14, tile_x(7.805, 14), tile_y(46.295, 14)) AS j14;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'sog'), 'sog-v2',
    'a trained tile is encoded by sog-v2');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j14 FROM jobs) AND op = 'sog'), 'sog-v2',
    'and so is the z14 under it');

-- The levels a tile publishes are a file like any other: content-addressed,
-- written once, and named in the store by their own sha (db/0051_sharedbytes).
SELECT lives_ok(
    $$ SELECT register_artifact(repeat('d', 64), 'lod', 512, 'sog-v2') $$,
    'a tile''s levels are a kind the store knows');
SELECT throws_ok(
    $$ SELECT register_artifact(repeat('e', 64), 'levels', 512, 'sog-v2') $$,
    '23514', NULL,
    'and a kind nobody declared is still refused');

-- The path the meta is written to is one can_write already allowed: the fixed
-- name the engine matches on is what the viewer calls the asset, never what is
-- on disk. Nobody holding the tile's sog atom may write there.
SELECT throws_ok(
    format('SELECT can_write(''/tiles/18/%s/%s/%s.json'', %L)',
           tile_x(7.805, 18), tile_y(46.295, 18), repeat('d', 64), repeat('d', 64)),
    'PT403', NULL,
    'the levels go where the .sog goes, under the same authority');

SELECT * FROM finish();
ROLLBACK;
