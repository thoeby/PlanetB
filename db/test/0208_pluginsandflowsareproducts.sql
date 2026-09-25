-- A plugin and a flow are products (db/0208).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000206c001', 'plug-maker@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-00000206c001');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000206c001","role":"player"}';

SELECT lives_ok(format($$SELECT can_write('/assets/%s.tar', %L, 100)$$,
    repeat('a', 64), repeat('a', 64)), 'a plugin folder is stored as a tar');
CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('a', 64), 'plugin', 100, 'plugin-tar-v1') AS p,
       register_artifact(repeat('b', 64), 'flow', 100, 'elx') AS f;
CREATE TEMP TABLE sans AS
SELECT register_asset(repeat('a', 64), 0::smallint, '{"name": "Motion", "type": "plugin",
           "license": "paid", "price": 3, "parts": {"plugin": "motion", "blocks": 6}}') AS plug,
       register_asset(repeat('b', 64), 0::smallint, '{"name": "Gate opens", "type": "flow",
           "license": "cc0"}') AS flow;
SELECT is((SELECT type FROM asset WHERE san = (SELECT plug FROM sans)), 'plugin',
          'a plugin is in the catalog as one');
SELECT is((SELECT type FROM asset WHERE san = (SELECT flow FROM sans)), 'flow',
          'and so is a flow');
CREATE TEMP TABLE again AS
SELECT register_asset(repeat('a', 64), 0::smallint, '{"name": "Motion", "type": "plugin",
    "parts": {"plugin": "motion", "blocks": 6}}') AS san;
SELECT is((SELECT san FROM again), (SELECT plug FROM sans),
          'the same folder registered again is the same product');
SELECT throws_like($$SELECT register_asset(repeat('b', 64), 0::smallint,
    '{"type": "plugin", "parts": {}}')$$, '%no plugin artifact%',
    'a flow is not a plugin');
SELECT throws_like($$SELECT check_asset_type('plugin', '{"parts": {"plugin": "a b"}}')$$,
    '%says its id%', 'and a plugin says its id');

SELECT * FROM finish();
ROLLBACK;
