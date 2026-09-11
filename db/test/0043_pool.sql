-- Submitting, and the pool anybody may render from (db/0043_pool.sql).
-- T6's acceptance in SQL: A submits with money, the work is public, B takes it.
BEGIN;
SELECT plan(13);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000c0001', 'pool-a@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000c0002', 'pool-b@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000c0001'), ('00000000-0000-0000-0000-0000000c0002');
-- A has a hundred coins to spend.
SELECT transfer(treasury_account(),
    (SELECT id FROM account WHERE owner_id = '00000000-0000-0000-0000-0000000c0001'),
    100, 'test:float:a');

INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000c0003',
 st_makeenvelope(70.0, 10.0, 70.05, 10.05, 4326),
 '00000000-0000-0000-0000-0000000c0001', 14);

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0001","role":"player"}';
SET LOCAL role = 'player';

-- Nothing is waiting until something is drawn.
SELECT is((SELECT (submit_area('00000000-0000-0000-0000-0000000c0003', 10) ->> 'tiles')::int),
    0, 'an area with nothing new on it submits nothing');

INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000c0003', 'forest',
        st_force3d(st_makeenvelope(70.01, 10.01, 70.02, 10.02, 4326)));

CREATE TEMP TABLE sent AS
SELECT submit_area('00000000-0000-0000-0000-0000000c0003', 10) AS out;

SELECT cmp_ok((SELECT (out ->> 'tiles')::int FROM sent), '>', 0,
    'a wood on your land is work for somebody');
SELECT is((SELECT (out ->> 'price_each')::numeric FROM sent), 10::numeric,
    'at the price you attached');

SELECT cmp_ok((SELECT count(*) FROM job WHERE state = 'open'), '>', 0::bigint,
    'the jobs are open');
SELECT is((SELECT count(DISTINCT bounty) FROM job WHERE state = 'open'), 1::bigint,
    'each carries the same price');

-- The money is in escrow, not in A's pocket. (escrow_account() is the
-- database's own; a player reads the ledger's effect, not the system accounts.)
SELECT cmp_ok(
    (SELECT amount FROM balance WHERE account_id = my_account()), '<', 100::numeric,
    'the price left the submitter''s wallet');
SET LOCAL role = 'postgres';
SELECT cmp_ok(
    (SELECT amount FROM balance WHERE account_id = escrow_account()), '>', 0::numeric,
    'and is held in escrow until somebody renders it');
SET LOCAL role = 'player';

-- The pool is public: B, who owns nothing here, sees the work.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c0002","role":"player"}';
SELECT cmp_ok((SELECT jsonb_array_length(render_pool(70.02, 10.02, 40))), '>', 0,
    'a stranger sees what is waiting');
SELECT is(
    (SELECT (j ->> 'bounty')::numeric FROM jsonb_array_elements(render_pool()) j LIMIT 1),
    10::numeric, 'and what it pays');
SELECT ok(
    (SELECT (j ->> 'metres')::double precision FROM
        jsonb_array_elements(render_pool(70.02, 10.02)) j LIMIT 1) < 20000,
    'and how far away it is');

-- Finest first: the leaf is what somebody is standing on.
SELECT is(
    (SELECT (j ->> 'z')::int FROM jsonb_array_elements(render_pool(70.02, 10.02)) j LIMIT 1),
    14, 'the deepest tile is offered first');

-- B takes one and it is theirs.
CREATE TEMP TABLE taken AS
SELECT claim_for((SELECT (j ->> 'job')::bigint FROM
    jsonb_array_elements(render_pool(70.02, 10.02)) j LIMIT 1),
    '{"webgpu": false, "vram_gb": 0}'::jsonb) AS a;
SELECT is((SELECT (a).state FROM taken), 'claimed', 'and claims it');
SELECT is((SELECT (a).op FROM taken), 'assemble',
    'starting where a tile starts');

ROLLBACK;
