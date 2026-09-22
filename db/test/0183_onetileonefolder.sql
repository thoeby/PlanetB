-- One tile, one folder: a leaf job is a dataset, a trainer and a pack, and
-- the dataset carries every view (db/0183).
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('one183@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'one183') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
INSERT INTO worker (user_id, trust) SELECT owner_id, 1 FROM ids;

SELECT results_eq(
    $$SELECT op, algo_version FROM atom WHERE job_id = (SELECT jid FROM j) ORDER BY id$$,
    $$VALUES ('dataset', 'dataset-v4'), ('train', 'train-v17'), ('sog', 'sog-v3')$$,
    'a leaf job is a dataset, a trainer and a pack');
SELECT is((SELECT (params ->> 'views')::int FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 81,
    'the dataset draws every view of the set');
SELECT is((SELECT params ->> 'camera_set' FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'z16-v3',
    'from the current camera set');
SELECT is((SELECT (inputs ->> 'dataset')::bigint FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'),
    (SELECT id FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'),
    'and the trainer reads it');

-- A dataset that drew fewer frames than the set has is refused.
CREATE TEMP TABLE ds AS SELECT * FROM claim_for((SELECT jid FROM j), '{}');
SELECT register_artifact(repeat('a', 64), 'dataset', 100, 'dataset-v4');
SELECT is(submit_atom((SELECT id FROM ds), repeat('a', 64),
    '{"splat_count": 10, "bytes": 100, "finite": true, "frames": 80,
      "bbox": [0, 0, 0, 1, 1, 1]}'), 'ready',
    'eighty frames of eighty-one is refused');
SELECT is((SELECT metrics ->> 'rule' FROM verification
           WHERE atom_id = (SELECT id FROM ds) ORDER BY at DESC LIMIT 1), 'frames',
    'by the frames rule');

-- Drawing every frame again puts the dataset back to the start.
CREATE TEMP TABLE ds2 AS SELECT * FROM claim_for((SELECT jid FROM j), '{}');
SELECT is(redo_renders((SELECT jid FROM j)), 1, 'redo_renders resets the one dataset');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM ds)), 'ready',
    'and it is ready to be drawn again');

SELECT * FROM finish();
ROLLBACK;
