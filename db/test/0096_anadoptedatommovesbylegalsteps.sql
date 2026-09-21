-- An atom a dead tab was still holding in a cancelled job is taken over by
-- the job that asks for it, through legal transitions; and z18 frames are
-- the size they are trained at.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land96@example.com', 'password12') AS owner_id;
INSERT INTO worker (id, user_id, caps, trust)
SELECT '00000000-0000-0000-0000-000000000961'::uuid, owner_id, '{}', 0.8 FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000096'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000096', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE tt AS SELECT 18 AS z, tile_x(7.805, 18) AS x, tile_y(46.295, 18) AS y;
CREATE TEMP TABLE first AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
CREATE TEMP TABLE asm AS
SELECT id FROM atom WHERE job_id = (SELECT jid FROM first) AND op = 'dataset';

-- A tab claims the dataset and goes away -- its claim has stopped beating
-- (db/0178: one that is still beating keeps the piece); the land is asked
-- for again.
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-000000000961',
                claimed_at = now() - interval '1 day', heartbeat_at = now() - interval '1 day'
WHERE id = (SELECT id FROM asm);
SELECT ok(recompile_land('00000000-0000-0000-0000-000000000096') > 0, 'the ground is marked');
SELECT lives_ok($$SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt))$$,
    'the new job opens over the claimed atom without an illegal transition');
CREATE TEMP TABLE second AS
SELECT id AS jid FROM job WHERE z = (SELECT z FROM tt) AND x = (SELECT x FROM tt)
  AND y = (SELECT y FROM tt) AND state = 'open';
SELECT is((SELECT job_id FROM atom WHERE id = (SELECT id FROM asm)), (SELECT jid FROM second),
    'the dataset atom moves to the new job');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM asm)), 'ready',
    'in nobody''s hands, ready for anybody');
SELECT is((SELECT worker_id FROM atom WHERE id = (SELECT id FROM asm)), null, 'no worker');

-- The frames the new job asks for: drawn by its dataset atom (db/0183).
SELECT is((SELECT min((params ->> 'size')::int) FROM atom
           WHERE job_id = (SELECT jid FROM second) AND op = 'dataset'), 1024,
    'z18 frames are 1024 px');
-- The z16 over the same ground has the z18 under it, so it asks for no frames
-- at all: it is merged from what is there (db/0135).
CREATE TEMP TABLE j16 AS
SELECT ensure_job(16, tile_x(7.805, 16), tile_y(46.295, 16)) AS jid;
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM j16) AND op = 'dataset'), 0,
    'a tile with children asks for no frames of its own');

SELECT * FROM finish();
ROLLBACK;
