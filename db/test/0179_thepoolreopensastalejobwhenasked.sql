-- A job at a version the world no longer builds is reopened when a tab asks
-- for its work, the heartbeat says why it refuses, and a tab can read its own
-- standing (db/0179).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('pool179@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'pool179') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
INSERT INTO worker (user_id, trust) SELECT owner_id, 1 FROM ids;

SELECT is((SELECT trust FROM jsonb_to_record(my_standing()) AS s (trust numeric)), 1::numeric,
    'my_standing says what the pool thinks of this tab');
SELECT is((SELECT (my_standing() -> 'needs' ->> 'train')::numeric), trust_min('train'),
    'and what training asks of it');

-- The world moved on: the assemble piece is at a version nobody builds.
UPDATE atom SET algo_version = 'assemble-v1',
                atom_hash = atom_hash(op, 'assemble-v1', inputs, params, seed)
WHERE job_id = (SELECT jid FROM j) AND op = 'assemble';
SELECT ok(stale_work_waiting(), 'the pool knows there is stale work in it');

-- Asking for that job by name reopens it and hands out the new piece.
CREATE TEMP TABLE got AS
SELECT * FROM claim_for((SELECT jid FROM j), '{"algo": {"assemble": "assemble-v11"}}');
SELECT is((SELECT algo_version FROM got), 'assemble-v11',
    'claim_for hands out the piece the world builds now');
SELECT isnt((SELECT job_id FROM got), (SELECT jid FROM j), 'out of the job that replaced it');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM j)), 'cancelled',
    'and the stale one is cancelled');
SELECT ok(NOT stale_work_waiting(), 'nothing stale is left waiting');

-- The heartbeat says why when the piece is not this tab's any more.
SELECT ok(hand_back_atom((SELECT id FROM got)), 'the tab hands the piece back');
SELECT throws_like($$SELECT heartbeat((SELECT id FROM got))$$, '%the world took it back%',
    'heartbeat says what became of the piece');

SELECT * FROM finish();
ROLLBACK;
