-- Somebody else's server may run a land's flow, for a term, under a key that
-- reaches no further (db/0211).
BEGIN;
SELECT plan(12);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000209b001', 'duty-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000209c001', 'duty-runner@example.com', 'x', 'player');
INSERT INTO account (owner_id) SELECT id FROM auth.user WHERE email LIKE 'duty-%';
DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 10, 'seed:duty')
    FROM account a WHERE a.owner_id = '00000000-0000-0000-0000-00000209b001';
END
$$;

INSERT INTO artifact (sha256, kind, bytes, algo_version) VALUES
(repeat('a', 64), 'glb', 10, 'canon-v2'), (repeat('f', 64), 'flow', 10, 'elx');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris, tex_bytes,
                   license, creator_id, type, parts)
VALUES ('SLAMPLAMPLAMP', repeat('a', 64), 2, 'Lampe', 'prop', '{}', 1, 0, 'cc0',
        '00000000-0000-0000-0000-00000209b001', 'model',
        '{"parts": [{"name": "head", "node": "head", "role": "light"}], "ports": [
          {"name": "on", "type": "boolean", "default": "false",
           "drives": {"part": "head", "what": "light"}}]}');
INSERT INTO area (id, geom, owner_id, detail) VALUES ('00000000-0000-0000-0000-0000000209a1',
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326),
    '00000000-0000-0000-0000-00000209b001', 14);
INSERT INTO instance (id, area_id, san, lon, lat) VALUES
('00000000-0000-0000-0000-0000000209e1', '00000000-0000-0000-0000-0000000209a1',
 'SLAMPLAMPLAMP', 7.862, 46.286);
INSERT INTO flow (id, area_id, name, elx_sha256, created_by)
VALUES ('00000000-0000-0000-0000-0000000209f1', '00000000-0000-0000-0000-0000000209a1',
        'Lamp at dusk', repeat('f', 64), '00000000-0000-0000-0000-00000209b001');
INSERT INTO process_server (id, owner_id, name, url) VALUES
('00000000-0000-0000-0000-0000000209d1', '00000000-0000-0000-0000-00000209c001',
 'beta', 'http://127.0.0.1:8092');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000209b001","role":"player"}';
CREATE TEMP TABLE d AS
SELECT offer_flow('00000000-0000-0000-0000-0000000209f1', interval '1 hour', 4) AS id;
GRANT SELECT ON d TO player, admin, flow;
SELECT is((SELECT elx_sha256 FROM duty WHERE id = (SELECT id FROM d)), repeat('f', 64),
          'the flow is offered by its hash');
SELECT is(duty_flow_name((SELECT duty FROM duty WHERE id = (SELECT id FROM d))),
          'Lamp at dusk', 'and by its name, which the pool may read');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000209b001')), 6::numeric,
    'with its bounty in escrow');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000209c001","role":"player"}';
CREATE TEMP TABLE claimed AS
SELECT claim_duty((SELECT id FROM d), '00000000-0000-0000-0000-0000000209d1') AS c;
GRANT SELECT ON claimed TO player, admin, flow;
SELECT is((SELECT state FROM duty WHERE id = (SELECT id FROM d)), 'claimed',
          'a stranger with a server takes it');
SELECT throws_like($$SELECT claim_duty((SELECT id FROM d),
    '00000000-0000-0000-0000-0000000209d1')$$, '%already running%', 'and nobody else can');

-- The key the stranger's server writes with.
SELECT set_config('request.jwt.claims', (SELECT json_build_object('role', 'flow',
    'sub', '00000000-0000-0000-0000-00000209b001', 'duty', (SELECT id FROM d),
    'jti', (SELECT key_jti FROM duty WHERE id = (SELECT id FROM d)))::text), true);
SET LOCAL ROLE flow;
SELECT is(port_write('00000000-0000-0000-0000-0000000209e1', 'on', '"true"') ->> 'value',
          'true', 'the key switches the lamp on its land');
RESET ROLE;
UPDATE duty SET ends_at = now() - interval '1 second' WHERE id = (SELECT id FROM d);
SET LOCAL ROLE flow;
SELECT throws_like($$SELECT port_write('00000000-0000-0000-0000-0000000209e1', 'on', '"false"')$$,
    '%not your land%', 'after the term, the key refuses');
RESET ROLE;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000209c001","role":"player"}';
UPDATE duty SET ends_at = now() + interval '1 hour' WHERE id = (SELECT id FROM d);
SELECT is(duty_receipt((SELECT id FROM d), '{"report": "r1", "code": 0}'), 1,
          'a run is a receipt');
SELECT throws_like($$SELECT settle_duty((SELECT id FROM d))$$, '%term runs until%',
    'nobody is paid before the term is over');
UPDATE duty SET ends_at = now() - interval '1 second' WHERE id = (SELECT id FROM d);
SELECT is(settle_duty((SELECT id FROM d)) ->> 'state', 'done', 'after it, the duty settles');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000209c001')), 4::numeric,
    'and whoever ran it is paid the bounty');

-- A flow that may pay is not offered to strangers.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000209b001","role":"player"}';
CREATE TEMP TABLE d2 AS
SELECT offer_flow('00000000-0000-0000-0000-0000000209f1', interval '1 hour', 0) AS id;
GRANT SELECT ON d2 TO player, admin;
UPDATE duty SET needs = '{"ports": "area", "pay": {"max_per_day": 5}}'
WHERE id = (SELECT id FROM d2);
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000209c001","role":"player"}';
SELECT throws_like($$SELECT claim_duty((SELECT id FROM d2),
    '00000000-0000-0000-0000-0000000209d1')$$, '%only somebody who builds on its land%',
    'a flow that may pay is not run by a stranger');

SELECT * FROM finish();
ROLLBACK;
