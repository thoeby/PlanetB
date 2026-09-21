-- A piece a tab is working on is not reset when a rebuild adopts it into a
-- new job; a quiet one still is (db/0178).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('hand178@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'hand178') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
UPDATE worker SET trust = 1 WHERE user_id = (SELECT owner_id FROM ids);

-- The tab takes the dataset piece.
CREATE TEMP TABLE held AS SELECT * FROM claim_for((SELECT jid FROM j), '{}');
SELECT is((SELECT op FROM held), 'dataset', 'the tab holds the dataset piece');

-- The job is cancelled and asked for again; the piece is adopted mid-run.
UPDATE job SET state = 'cancelled' WHERE id = (SELECT jid FROM j);
CREATE TEMP TABLE j2 AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
SELECT isnt((SELECT jid FROM j2), (SELECT jid FROM j), 'a new job was opened');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM held)), 'claimed',
    'the piece is still claimed');
SELECT is((SELECT worker_id FROM atom WHERE id = (SELECT id FROM held)),
    (SELECT worker_id FROM held), 'by the same tab');
SELECT is((SELECT job_id FROM atom WHERE id = (SELECT id FROM held)), (SELECT jid FROM j2),
    'and belongs to the new job');

-- A claim that went quiet is reset as before.
UPDATE atom SET heartbeat_at = now() - interval '1 day', claimed_at = now() - interval '1 day'
WHERE id = (SELECT id FROM held);
UPDATE job SET state = 'cancelled' WHERE id = (SELECT jid FROM j2);
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14));
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM held)), 'ready',
    'a quiet claim is taken back');

SELECT * FROM finish();
ROLLBACK;
