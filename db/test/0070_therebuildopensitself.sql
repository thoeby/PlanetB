-- db/0070_therebuildopensitself.sql — a submission is the tiles that are built
-- from what somebody drew, the rebuild above them opens when a child lands, and
-- the pool offers no work that cannot be taken (REFACTOR-direct-pg.md S7).
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids AS
SELECT register('own70@example.com', 'password12') AS owner_id,
       register('w70@example.com', 'password12') AS worker_id;
GRANT SELECT ON ids TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000b1'::uuid,
       st_geomfromtext('POLYGON((7.50 46.50,7.51 46.50,7.51 46.51,7.50 46.51,'
                       '7.50 46.50))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'footprint',
        st_geomfromtext('POINTZ(7.505 46.505 500)', 4326));

CREATE TEMP TABLE tt AS SELECT tile_x(7.505, 14) AS x, tile_y(46.505, 14) AS y;
GRANT SELECT ON tt TO player;

-- What the land is waiting for: the ladder from z6 down is dirty, and only the
-- bottom of it is anybody's to approve (SPEC §5.3).
SELECT cmp_ok(
    (SELECT count(*) FROM tile t
     WHERE t.dirty AND st_intersects(
         (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-0000000000b1'),
         tile_bbox(t.z, t.x, t.y))), '>', 1::bigint,
    'every zoom over this land is dirty');

CREATE TEMP TABLE sub AS
SELECT submit_area('00000000-0000-0000-0000-0000000000b1', 'a house') AS s;
SELECT is((SELECT count(DISTINCT z) FROM submission_tile), 1::bigint,
          'a submission is one zoom deep');
SELECT is((SELECT DISTINCT z FROM submission_tile), 14,
          'and it is the zoom the world is built at');

SELECT is((SELECT ((s -> 'changes') ->> 'tiles')::int FROM sub), 1,
          'and the dialog counted the same tiles it sent');

CREATE TEMP TABLE ap AS
SELECT approve_submission(((SELECT s FROM sub) ->> 'id')::uuid, 0) AS a;
SELECT is((SELECT (a ->> 'queued')::int FROM ap), 1,
          'approving opens one job, not the whole ladder');

-- S7, the first half: a merge with nothing published under it is not offered.
CREATE TEMP TABLE coarse AS
SELECT ensure_job(12, (SELECT x FROM tt) / 4, (SELECT y FROM tt) / 4, 0) AS jid;
GRANT SELECT ON coarse TO player;
SELECT ok(EXISTS (SELECT 1 FROM job WHERE id = (SELECT jid FROM coarse)
                  AND state = 'open'),
          'a coarse job can be opened before its children exist');
SELECT is((SELECT count(*) FROM jsonb_array_elements(render_pool(null, null, 40)) e
           WHERE (e ->> 'job')::bigint = (SELECT jid FROM coarse)), 0::bigint,
          'but the pool does not offer it: nothing under it is published');
SELECT is((SELECT count(*) FROM jsonb_array_elements(render_pool(null, null, 40)) e
           WHERE (e ->> 'z')::int = 14), 1::bigint,
          'the tile that is built from the world is what is offered');
SELECT is((SELECT e ->> 'made' FROM jsonb_array_elements(render_pool(null, null, 40)) e
           WHERE (e ->> 'z')::int = 14), 'assembled',
          'and the pool says what it is, from the job itself');

-- The three pieces of a z14 tile, run by somebody who owns none of it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;

CREATE TEMP TABLE a1 AS SELECT * FROM claim_for((SELECT id FROM job
    WHERE z = 14 AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)), '{}'::jsonb);
SELECT is((SELECT op FROM a1), 'assemble', 'the tile is assembled first');
SELECT is(submit_atom((SELECT id FROM a1),
    register_artifact(repeat('a', 64), 'init_ply', 4096, 'assemble-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-1, -1, -1, 1, 1, 1]}'::jsonb), 'verified', 'and it verifies');

CREATE TEMP TABLE a2 AS SELECT * FROM claim_for((SELECT job_id FROM a1), '{}'::jsonb);
SELECT is(submit_atom((SELECT id FROM a2),
    register_artifact(repeat('b', 64), 'ply', 4096, 'sample-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-1, -1, -1, 1, 1, 1]}'::jsonb), 'verified', 'then sampled');

CREATE TEMP TABLE a3 AS SELECT * FROM claim_for((SELECT job_id FROM a1), '{}'::jsonb);
SELECT ok(submit_atom((SELECT id FROM a3),
    register_artifact(repeat('c', 64), 'sog', 2048, 'sog-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-1, -1, -1, 1, 1, 1]}'::jsonb) = 'verified'
    AND publish_tile(14, (SELECT x FROM tt), (SELECT y FROM tt),
        (SELECT target_version FROM job WHERE id = (SELECT job_id FROM a1)),
        repeat('c', 64),
        '{"origin": {"lon": 7.505, "lat": 46.505, "h": 500}}'::jsonb),
    'and what lands is published');

-- S7, the other half, and SPEC §5.3: the rebuild is in the pool because the
-- child landed, not because anybody pressed anything.
SELECT is((SELECT count(*) FROM jsonb_array_elements(render_pool(null, null, 40)) e
           WHERE (e ->> 'z')::int = 12 AND e ->> 'made' = 'merged from its children'),
          1::bigint,
          'publishing a child puts its parent''s rebuild in the pool, free');

SELECT * FROM finish();
ROLLBACK;
