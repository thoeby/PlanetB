-- Compile it all again on ground nobody changed: the new job takes over the
-- old job's verified atoms and publishes from its sog at once.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land100@example.com', 'password12') AS owner_id;
INSERT INTO worker (id, user_id, caps, trust)
SELECT '00000000-0000-0000-0000-000000001001'::uuid, owner_id, '{}', 0.8 FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000100'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000100', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE tt AS SELECT 14 AS z, tile_x(7.805, 14) AS x, tile_y(46.295, 14) AS y;
CREATE TEMP TABLE first AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

-- The old job did all its work: assemble, sample and sog verified, the sog
-- with its output and manifest — and then never published (the tab left).
UPDATE atom SET state = 'ready' WHERE job_id = (SELECT jid FROM first) AND state = 'waiting';
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-000000001001',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = (SELECT jid FROM first);
UPDATE atom SET state = 'verified', output_sha256 = repeat('c', 64),
    result = jsonb_build_object('manifest', jsonb_build_object('origin',
        jsonb_build_object('lon', 7.805, 'lat', 46.295, 'h', 650), 'splats', 10))
WHERE job_id = (SELECT jid FROM first);
CREATE TEMP TABLE oldsog AS
SELECT id FROM atom WHERE job_id = (SELECT jid FROM first) AND op = 'sog';

SELECT ok(recompile_land('00000000-0000-0000-0000-000000000100') > 0, 'compile it all again');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM first)), 'cancelled',
    'the old job is cancelled');
CREATE TEMP TABLE second AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT isnt((SELECT jid FROM second), (SELECT jid FROM first), 'a new job');
SELECT is((SELECT job_id FROM atom WHERE id = (SELECT id FROM oldsog)), (SELECT jid FROM second),
    'the verified sog moved to the new job');
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM second)), 3::bigint,
    'and so did the assemble and the sample: the job owns what it asked for');
SELECT is((SELECT published_version FROM tile
           WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)),
    (SELECT expected_version FROM tile
     WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt) AND y = (SELECT y FROM tt)),
    'the tile is published at the new version from the sog already made');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM second)), 'done',
    'and the job is done');

SELECT * FROM finish();
ROLLBACK;
