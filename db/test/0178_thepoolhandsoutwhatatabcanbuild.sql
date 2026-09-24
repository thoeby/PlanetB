-- A tab is handed only the pieces it builds, a job at a version the world no
-- longer builds is reopened at the one it does, and a piece in a tab's hands
-- stays there through a rebuild (db/0178).
BEGIN;
SELECT plan(12);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('pool178@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

-- build_dag makes what algo_current says, op by op: the one definition.
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'pool178') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT jid FROM j)
             AND algo_version IS DISTINCT FROM algo_current(op)), 0::bigint,
    'build_dag makes every op at the version algo_current names');
SELECT is((SELECT count(DISTINCT op) FROM atom WHERE job_id = (SELECT jid FROM j)),
    3::bigint, 'dataset, train and sog, at z14 (db/0183)');

-- A tab that builds an older trainer is not handed the train piece.
INSERT INTO worker (user_id, trust) SELECT owner_id, 1 FROM ids;
-- Everything but the train piece is done, by the legal steps (db/0005_state).
UPDATE atom SET state = 'ready' WHERE job_id = (SELECT jid FROM j)
    AND op <> 'train' AND state = 'waiting';
UPDATE atom SET state = 'claimed', claimed_at = now(),
    worker_id = (SELECT id FROM worker WHERE user_id = (SELECT owner_id FROM ids))
WHERE job_id = (SELECT jid FROM j) AND op <> 'train';
UPDATE atom SET state = 'verified' WHERE job_id = (SELECT jid FROM j) AND op <> 'train';
UPDATE atom SET state = 'ready' WHERE job_id = (SELECT jid FROM j) AND op = 'train';
SELECT is((SELECT id FROM claim_atom('{"webgpu": true, "max_buffer_mb": 100000,
    "ops": ["train"], "algo": {"train": "train-v1"}}')), NULL::bigint,
    'a tab building train-v1 is handed no train-v21 piece');
SELECT is((SELECT id FROM claim_for((SELECT jid FROM j), '{"webgpu": true,
    "max_buffer_mb": 100000, "algo": {"train": "train-v1"}}')), NULL::bigint,
    'nor when it asks for that job by name');
SELECT is((SELECT op FROM claim_for((SELECT jid FROM j), '{"webgpu": true,
    "max_buffer_mb": 100000, "algo": {"train": "train-v21"}}')), 'train',
    'a tab building train-v21 is');
SELECT ok(hand_back_atom((SELECT id FROM atom
    WHERE job_id = (SELECT jid FROM j) AND op = 'train')), 'and hands it back');
SELECT is((SELECT op FROM claim_atom('{"webgpu": true, "max_buffer_mb": 100000,
    "ops": ["train"]}')), 'train', 'a tab that names no versions is trusted as before');
SELECT ok(hand_back_atom((SELECT id FROM atom
    WHERE job_id = (SELECT jid FROM j) AND op = 'train')), 'and hands it back');

-- A job whose train piece is at a version the world no longer builds is
-- reopened at the one it does, and the verified pieces come with it.
UPDATE atom SET algo_version = 'train-v13',
                atom_hash = atom_hash(op, 'train-v13', inputs, params, seed)
WHERE job_id = (SELECT jid FROM j) AND op = 'train';
SELECT is(refresh_stale_jobs(), 1, 'one job was stranded by the version bump');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM j)), 'cancelled',
    'the stranded job is cancelled');
CREATE TEMP TABLE j2 AS
SELECT live_job(14, tile_x(7.885, 14), tile_y(46.295, 14),
    (SELECT expected_version FROM tile
     WHERE z = 14 AND x = tile_x(7.885, 14) AND y = tile_y(46.295, 14))) AS jid;
SELECT is((SELECT algo_version FROM atom WHERE job_id = (SELECT jid FROM j2) AND op = 'train'),
    'train-v21', 'and the same version of the tile has a train-v21 piece now');
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM j2)
           AND op = 'dataset' AND state = 'verified'),
    (SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM j2) AND op = 'dataset'),
    'with the dataset it had already made');

SELECT * FROM finish();
ROLLBACK;
