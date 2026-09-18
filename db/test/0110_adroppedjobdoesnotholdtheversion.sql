-- A job dropped from the pool leaves its version behind it: the same version
-- comes round again (drop_job winds expected_version back, db/0105) and asking
-- for it opens a new job beside the cancelled one, rather than breaking on the
-- key that used to count cancelled jobs as jobs.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land110@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000111'::uuid,
       st_geomfromtext('POLYGON((7.86 46.29,7.87 46.29,7.87 46.30,7.86 46.30,7.86 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000111', 'building',
        st_geomfromtext('POINTZ(7.865 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE tt AS SELECT 14 AS z, tile_x(7.865, 14) AS x, tile_y(46.295, 14) AS y;
SELECT recompile_land('00000000-0000-0000-0000-000000000111');
CREATE TEMP TABLE first AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

SELECT ok(drop_job((SELECT jid FROM first)), 'the job is dropped from the pool');
SELECT is((SELECT expected_version FROM tile
           WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)),
    0::bigint, 'and the tile is back at what is published (db/0105)');

-- The ground changes again, as many times as it takes to come back to the
-- version the dropped job was opened at.
DO $$
BEGIN
    WHILE (SELECT expected_version FROM tile
           WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt))
          < (SELECT target_version FROM job WHERE id = (SELECT jid FROM first)) LOOP
        PERFORM recompile_land('00000000-0000-0000-0000-000000000111');
    END LOOP;
END $$;
SELECT is((SELECT expected_version FROM tile
           WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)),
    (SELECT target_version FROM job WHERE id = (SELECT jid FROM first)),
    'the tile is at the version the dropped job was opened at');

CREATE TEMP TABLE second AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT isnt((SELECT jid FROM second), (SELECT jid FROM first),
    'asking again opens a new job, not the dropped one');
SELECT is((SELECT count(*) FROM job
           WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)
             AND state <> 'cancelled'), 1::bigint,
    'and one live job holds that tile');

SELECT * FROM finish();
ROLLBACK;
