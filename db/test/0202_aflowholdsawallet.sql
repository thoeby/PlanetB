-- A flow can hold a wallet (db/0202_aflowholdsawallet.sql).
BEGIN;
SELECT plan(13);

DELETE FROM auth.user;
SELECT register('anna202@example.com', 'password12') AS anna,
       register('ben202@example.com', 'password12') AS ben,
       register('cara202@example.com', 'password12') AS cara \gset
UPDATE auth.user SET name = initcap(split_part(email, '202', 1));
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test'), (:'cara', 'verified', 'manual', 'test');
SELECT id AS annas FROM item WHERE held_by = :'anna' \gset
UPDATE wallet SET balance = 100;
DELETE FROM wallet_order;
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8081/geoserver', 'splatworld:visp',
        st_makeenvelope(7.8545, 46.2759, 7.9085, 46.3119, world_srid()), :'anna');
INSERT INTO area (geom, owner_id, detail)
VALUES (st_makeenvelope(7.880, 46.290, 7.882, 46.292, world_srid()), :'anna', 14)
RETURNING id AS land \gset
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('e', 64), 'flow', 10, 'elx-v1') ON CONFLICT DO NOTHING;
INSERT INTO flow (area_id, name, elx_sha256, created_by)
VALUES (:'land', 'till', repeat('e', 64), :'anna') RETURNING id AS till \gset

CREATE FUNCTION acting_as(uid uuid, f uuid DEFAULT null) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text := (SELECT role FROM auth.user WHERE id = uid);
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r, 'flow', f)::text);
    EXECUTE format('SET LOCAL ROLE %I', r);
END
$$;
GRANT EXECUTE ON FUNCTION acting_as(uuid, uuid) TO player, admin;

SELECT acting_as(:'ben');
SELECT throws_ok(format($$SELECT flow_key(%L)$$, :'till'), '42501',
                 'only somebody who may build on its land keys a flow',
                 'Ben may not key a flow on Anna''s land');
RESET ROLE;
SELECT acting_as(:'anna');
SELECT is(give_to_flow(:'annas', :'till') ->> 'flow', 'till', 'Anna gives the till a wallet');
SELECT ok(NOT holds(:'annas'), 'and holds it no more');
SELECT is(flow_wallets(:'till') -> 0 ->> 'balance', '100.00', 'she sees what the till holds');
SELECT flow_key(:'till') AS key \gset
RESET ROLE;
SELECT ok(auth.verify(:'key') ->> 'flow' = :'till', 'and keys the till');

SELECT acting_as(:'anna', :'till');
SELECT ok(holds(:'annas'), 'with its key, the till holds the wallet');
SELECT is(wallet_balance(:'annas'), 100.00, 'reads its balance');
SELECT is(wallet_request(:'annas', 'Ben', 2, 'the till') ->> 'from', 'Ben',
          'and asks Ben for 2');
SELECT is(jsonb_array_length(my_items()), 0, 'a flow''s key holds no player''s things');
RESET ROLE;
UPDATE wallet_order SET state = 'done' WHERE kind = 'request';
SELECT acting_as(:'anna', :'till');
SELECT is(money_received(:'annas') -> 0 ->> 'from', 'Ben', 'money received says from whom');
RESET ROLE;

SELECT acting_as(:'anna');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Ben', 1, '')$$, :'annas'), '42501',
                 'you do not hold that wallet', 'Anna''s own key does not spend the till''s');
SELECT is(take_from_flow(:'annas') ->> 'held', 'true', 'Anna takes the wallet back');
SELECT ok(holds(:'annas'), 'and holds it again');

SELECT * FROM finish();
ROLLBACK;
