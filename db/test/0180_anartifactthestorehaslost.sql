-- An artifact the store has lost is forgotten by the tab holding the work
-- that makes or reads it, and the atom that made it starts again (db/0180).
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('lost180@example.com', 'password12') AS owner_id,
       register('other180@example.com', 'password12') AS other_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'lost180') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
INSERT INTO worker (user_id, trust) SELECT owner_id, 1 FROM ids;

-- The dataset is done and its bytes registered; then the store loses them.
CREATE TEMP TABLE asm AS
SELECT * FROM claim_for((SELECT jid FROM j), '{}');
SELECT register_artifact(repeat('9', 64), 'dataset', 100, 'dataset-v2');
UPDATE atom SET state = 'verified', output_sha256 = repeat('9', 64), result = '{}'
WHERE id = (SELECT id FROM asm);
SELECT advance_atoms((SELECT jid FROM j));
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM asm)), 'verified',
    'the dataset is verified');
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM j)
           AND op = 'train' AND state = 'ready'), 1::bigint, 'and its training is ready');

-- A tab holding the training says the dataset's bytes are gone.
CREATE TEMP TABLE frm AS
SELECT * FROM claim_for((SELECT jid FROM j), '{"webgpu": true, "max_buffer_mb": 100000}');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_like($$SELECT artifact_missing(repeat('9', 64))$$, '%only a tab that is holding%',
    'somebody holding nothing may not say so');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT is(artifact_missing(repeat('9', 64)), 1, 'the tab holding the training may');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM asm)), 'ready',
    'the dataset starts again');
SELECT is((SELECT output_sha256 FROM atom WHERE id = (SELECT id FROM asm)), NULL,
    'with no output');
SELECT ok(NOT EXISTS (SELECT 1 FROM artifact WHERE sha256 = repeat('9', 64)),
    'and the artifact is forgotten, so it can be written again');
SELECT is((SELECT count(*) FROM tile_event WHERE atom_id = (SELECT id FROM asm)
           AND detail LIKE '%gone from the store%'), 1::bigint, 'the tile remembers why');

SELECT * FROM finish();
ROLLBACK;
