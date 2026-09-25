-- The registrar moves a channel to a file, a flow and what it needs; the same
-- folder twice records nothing (db/0209).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000207c001', 'reg-maker@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000207b001', 'reg-other@example.com', 'x', 'player');

SELECT register_artifact(repeat('3', 64), 'glb', 1024, 'canon-v1'),
       register_artifact(repeat('4', 64), 'glb', 1024, 'canon-v1'),
       register_artifact(repeat('e', 64), 'flow', 10, 'elx');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000207c001","role":"player"}';
CREATE TEMP TABLE p AS
SELECT register_asset(repeat('3', 64), 1::smallint, '{"name": "Barriere"}'::jsonb) AS san;
GRANT SELECT ON p TO player;

SELECT is(my_product('Barriere'), (SELECT san FROM p), 'the maker finds the product by name');
SELECT set_pointer((SELECT san FROM p), 'current', repeat('4', 64), false,
    '{"ports": "area"}', repeat('e', 64));
SELECT is((latest_version((SELECT san FROM p))).flow_sha256, repeat('e', 64),
    'the version carries its flow');
SELECT is((latest_version((SELECT san FROM p))).needs, '{"ports": "area"}'::jsonb,
    'and what it needs');
SELECT is((SELECT count(*)::int FROM asset_version WHERE san = (SELECT san FROM p)), 2,
    'one version more than it was registered with');
SELECT set_pointer((SELECT san FROM p), 'current', repeat('4', 64), false,
    '{"ports": "area"}', repeat('e', 64));
SELECT is((SELECT count(*)::int FROM asset_version WHERE san = (SELECT san FROM p)), 2,
    'the same folder again records nothing');
SELECT throws_like($$SELECT set_pointer((SELECT san FROM p), 'current', repeat('4', 64),
    false, '{}', repeat('3', 64))$$, '%no flow artifact%', 'a flow is a flow artifact');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000207b001","role":"player"}';
SELECT throws_like($$SELECT set_pointer((SELECT san FROM p), 'current', repeat('3', 64),
    false, '{}', NULL)$$, '%only its maker%', 'nobody else moves it');

SELECT * FROM finish();
ROLLBACK;
