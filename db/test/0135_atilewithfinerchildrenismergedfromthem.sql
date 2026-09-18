-- A tile is a leaf when nothing finer stands on its ground, and not otherwise.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land135@example.com', 'password12') AS owner_id;

-- Drawn at detail 14, so the ladder this land materialises stops there.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000135'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))', 4326),
       ids.owner_id, 14
FROM ids;

CREATE TEMP TABLE at AS SELECT tile_x(7.805, 14) AS x, tile_y(46.295, 14) AS y;

SELECT ok((SELECT is_leaf_tile(14, x, y) FROM at),
    'a z14 with nothing under it is where the world is made');
SELECT ok((SELECT NOT is_leaf_tile(12, x / 4, y / 4) FROM at),
    'and its parent, having it, is not');

-- Somebody earns a finer tile over the same ground.
INSERT INTO tile (z, x, y) SELECT 16, x * 4, y * 4 FROM at;
SELECT ok((SELECT NOT is_leaf_tile(14, x, y) FROM at),
    'the z14 stops being a leaf the moment something finer exists over it');
SELECT ok((SELECT is_leaf_tile(16, x * 4, y * 4) FROM at),
    'while the child, having nothing under it, is one');

-- And the job built for that z14 is a merge, not a second render of the ground.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
UPDATE tile SET expected_version = 1
WHERE z = 14 AND (x, y) = (SELECT x, y FROM at);
CREATE TEMP TABLE j AS SELECT ensure_job(14, x, y) AS jid FROM at;

SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'merge'), 1,
    'the parent is merged from what is under it');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM j)
             AND op IN ('assemble', 'frame', 'train')), 0,
    'and is not rendered a second time from the mesh');

SELECT * FROM finish();
ROLLBACK;
