-- A thing runs no more than its owner said yes to (db/0210).
BEGIN;
SELECT plan(10);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000208c001', 'need-maker@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000208b001', 'need-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000208d001', 'need-other@example.com', 'x', 'player');
INSERT INTO account (owner_id) SELECT id FROM auth.user WHERE email LIKE 'need-%';

SELECT ok(needs_within('{"ports": "own"}', '{"ports": "area"}'), 'the land''s ports include its own');
SELECT ok(NOT needs_within('{"pay": {"max_per_day": 5}}', '{"ports": "own"}'),
          'paying is asked for, never assumed');
SELECT is(needs_words('{"ports": "own", "pay": {"max_per_day": 5}}', '{"ports": "own"}'),
          'pay up to 5 a day', 'and said in words');

CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('c', 64), 'glb', 1024, 'canon-v1') AS g,
       register_artifact(repeat('d', 64), 'flow', 100, 'elx') AS f1,
       register_artifact(repeat('e', 64), 'flow', 100, 'elx') AS f2;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208c001","role":"player"}';
CREATE TEMP TABLE sans AS
SELECT register_asset(repeat('c', 64), 1::smallint,
    '{"name": "Schranke", "license": "cc0"}'::jsonb) AS san;
CREATE TEMP TABLE v1 AS SELECT set_pointer((SELECT san FROM sans), 'current', repeat('c', 64),
    false, '{"ports": "own"}', repeat('d', 64)) AS p;

-- The owner buys it and puts it on their land: that is saying yes to v1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208b001","role":"player"}';
CREATE TEMP TABLE bought AS SELECT order_create((SELECT san FROM sans), 1, NULL) AS o;
UPDATE asset_right SET acquired_at = now() - interval '1 hour'
WHERE san = (SELECT san FROM sans);
UPDATE asset_version SET at = now() - interval '2 hours' WHERE san = (SELECT san FROM sans);
INSERT INTO area (id, geom, owner_id, detail)
VALUES ('00000000-0000-0000-0000-0000000208a1',
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326),
    '00000000-0000-0000-0000-00000208b001', 14);
INSERT INTO instance (id, area_id, san, lon, lat)
SELECT '00000000-0000-0000-0000-0000000208f1', '00000000-0000-0000-0000-0000000208a1',
       san, 7.862, 46.286 FROM sans;
CREATE TEMP TABLE t AS SELECT '00000000-0000-0000-0000-0000000208f1'::uuid AS id;
GRANT SELECT ON t, sans TO player, admin;

SELECT is((instance_version((SELECT id FROM t))).flow_sha256, repeat('d', 64),
          'placed, it runs the version it was placed at');

-- A fix that also asks to pay.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208c001","role":"player"}';
CREATE TEMP TABLE v2 AS SELECT set_pointer((SELECT san FROM sans), 'current', repeat('c', 64),
    true, '{"ports": "own", "pay": {"max_per_day": 5}}', repeat('e', 64)) AS p;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208b001","role":"player"}';
SELECT is((instance_version((SELECT id FROM t))).flow_sha256, repeat('d', 64),
          'a fix that adds pay leaves it on the version it had');
SELECT is(update_waiting((SELECT id FROM t)) ->> 'waiting', 'true', 'and the owner is told');
SELECT is(update_waiting((SELECT id FROM t)) ->> 'asks', 'pay up to 5 a day',
          'what it asks for, in words');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208d001","role":"player"}';
SELECT throws_like($$SELECT allow_update((SELECT id FROM t))$$, '%only who owns the land%',
    'somebody else cannot say yes for the owner');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000208b001","role":"player"}';
SELECT is(allow_update((SELECT id FROM t)) ->> 'waiting', 'false', 'the owner presses Allow');
SELECT is((instance_version((SELECT id FROM t))).flow_sha256, repeat('e', 64),
          'and it runs the fix');

SELECT * FROM finish();
ROLLBACK;
