-- Land drawn at a coarse detail is still built.
--
-- An area at detail 10 has no tiles below z10, so its finest tile used to be a
-- merge of sixteen children that do not exist: never handed out
-- (db/0035_mergeready.sql), never rendered, and nothing said so. A tile with
-- nothing under it is the bottom of its own ladder now, and is assembled and
-- sampled the way a z14 leaf is (db/0045_coarseleaf.sql).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('coarse@example.com', 'password12') AS owner_id;

-- Two pieces of land: one at the baseline, one deliberately coarse. They are
-- far apart so no tile belongs to both.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000d1'::uuid,
       st_geomfromtext('POLYGON((9.4 46.4,9.6 46.4,9.6 46.6,9.4 46.6,9.4 46.4))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000d2'::uuid,
       st_geomfromtext('POLYGON((0.4 0.4,0.6 0.4,0.6 0.6,0.4 0.6,0.4 0.4))', 4326),
       ids.owner_id, 10
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'footprint',
        st_geomfromtext('POINTZ(9.5 46.5 400)', 4326));
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000d2', 'forest',
        st_geomfromtext('POLYGONZ((0.45 0.45 0,0.55 0.45 0,0.55 0.55 0,0.45 0.55 0,0.45 0.45 0))',
                        4326));

CREATE TEMP TABLE coarse AS
SELECT t.z, t.x, t.y FROM tile t
WHERE st_intersects(tile_bbox(t.z, t.x, t.y),
                    (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-0000000000d2'))
ORDER BY t.z DESC LIMIT 1;

SELECT is((SELECT z::int FROM coarse), 10,
    'land at detail 10 has nothing finer than z10');
SELECT ok(is_leaf_tile((SELECT z FROM coarse), (SELECT x FROM coarse),
                       (SELECT y FROM coarse)),
    'so its finest tile is where the world is made');
SELECT ok(NOT is_leaf_tile(6, (SELECT x / 16 FROM coarse), (SELECT y / 16 FROM coarse)),
    'and the one above it still has something to merge');

-- The DAG it gets ------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM coarse), (SELECT x FROM coarse),
                  (SELECT y FROM coarse)) AS jid;

SELECT is((SELECT array_agg(op ORDER BY id) FROM atom WHERE job_id = (SELECT jid FROM jobs)),
    ARRAY['assemble', 'sample', 'sog'],
    'it is assembled and sampled, not merged out of nothing');

-- And it is actually handed out, which is the whole point ---------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE claimed AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM claimed), 'assemble',
    'a tab asking for work is given it');
SELECT is((SELECT j.z::int FROM job j WHERE j.id = (SELECT job_id FROM claimed)),
    (SELECT z::int FROM coarse), 'for that very tile');

-- A tile above land at the baseline is unchanged ------------------------
CREATE TEMP TABLE fine AS
SELECT c.z - 2 AS z, c.x / 4 AS x, c.y / 4 AS y
FROM tile c WHERE c.z = 14
  AND st_intersects(tile_bbox(c.z, c.x, c.y),
      (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-0000000000d1'))
ORDER BY c.x, c.y
LIMIT 1;
SELECT ok(NOT is_leaf_tile((SELECT z FROM fine), (SELECT x FROM fine),
                           (SELECT y FROM fine)),
    'a z12 over land at the baseline still merges');
SELECT ok(is_leaf_tile(14, 0, 0), 'z14 is a leaf wherever it is');
SELECT ok(is_leaf_tile(18, 0, 0), 'and so is z18');

SELECT * FROM finish();
ROLLBACK;
