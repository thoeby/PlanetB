-- A job's kind is the step it has got to, not what happens to be free: a tile
-- whose training is in somebody's hands is training, not render work. And the
-- row says what the steps are and how far each has got.
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('steps153@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.88, 46.30);
SELECT compile_ground();

-- One leaf job: the dataset (its ground and frames, db/0183), the training,
-- the packing.
CREATE TEMP TABLE one AS
SELECT p.job_id AS job FROM pool_open p
WHERE EXISTS (SELECT 1 FROM atom a WHERE a.job_id = p.job_id AND a.op = 'train')
ORDER BY p.job_id LIMIT 1;

SELECT is((SELECT phase FROM pool_open WHERE job_id = (SELECT job FROM one)), 'render',
    'a job with its ground still to assemble is render work');
SELECT is((SELECT jsonb_array_length(job_steps((SELECT job FROM one)))), 3,
    'and it is three steps: dataset, training, packing');
SELECT is((SELECT job_steps((SELECT job FROM one)) -> 0 ->> 'op'), 'dataset',
    'in the order they are done');
SELECT is((SELECT job_steps((SELECT job FROM one)) -> 0 ->> 'state'), 'to do',
    'the first of them is the one to do');

-- Everything but the training done, and the training in a tab's hands: no
-- atom is ready, and the job is training all the same. The states are walked
-- one at a time because atom_state_guard allows no shortcuts (db/0017).
UPDATE atom SET state = 'ready'
WHERE job_id = (SELECT job FROM one) AND op IN ('dataset', 'train')
  AND state = 'waiting';
UPDATE atom SET state = 'claimed', worker_id = my_worker('{}'::jsonb),
    claimed_at = now(), heartbeat_at = now()
WHERE job_id = (SELECT job FROM one) AND op IN ('dataset', 'train')
  AND state = 'ready';
UPDATE atom SET state = 'verified'
WHERE job_id = (SELECT job FROM one) AND op = 'dataset';

SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT job FROM one) AND state = 'ready'), 0::bigint,
    'nothing on the job can be taken');
SELECT is((SELECT phase FROM pool_open WHERE job_id = (SELECT job FROM one)), 'train',
    'and the job is in training, where the tab holding it is looking');
SELECT is((SELECT s ->> 'state' FROM jsonb_array_elements(
               job_steps((SELECT job FROM one))) s WHERE s ->> 'op' = 'train'),
    'in hand', 'the step says it is in somebody''s hands');
SELECT is((SELECT s ->> 'done' FROM jsonb_array_elements(
               job_steps((SELECT job FROM one))) s WHERE s ->> 'op' = 'dataset'),
    (SELECT s ->> 'total' FROM jsonb_array_elements(
               job_steps((SELECT job FROM one))) s WHERE s ->> 'op' = 'dataset'),
    'and the frames before it are all drawn');

SELECT * FROM finish();
ROLLBACK;
