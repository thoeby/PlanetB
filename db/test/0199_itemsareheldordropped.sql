-- A wallet is a thing you hold (db/0199_itemsareheldordropped.sql).
BEGIN;
SELECT plan(15);

DELETE FROM auth.user;
SELECT register('anna199@example.com', 'password12') AS anna,
       register('ben199@example.com', 'password12') AS ben,
       register('cara199@example.com', 'password12') AS cara,
       register('dora199@example.com', 'password12') AS dora \gset
UPDATE auth.user SET name = initcap(split_part(email, '199', 1));
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test'), (:'cara', 'verified', 'manual', 'test');
SELECT id AS annas FROM item WHERE held_by = :'anna' \gset
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8081/geoserver', 'splatworld:visp',
        st_makeenvelope(7.8545, 46.2759, 7.9085, 46.3119, world_srid()), :'anna');
INSERT INTO area (geom, owner_id, detail)
VALUES (st_makeenvelope(7.880, 46.290, 7.882, 46.292, world_srid()), :'ben', 14);

CREATE FUNCTION acting_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text := (SELECT role FROM auth.user WHERE id = uid);
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
    EXECUTE format('SET LOCAL ROLE %I', r);
END
$$;
GRANT EXECUTE ON FUNCTION acting_as(uuid) TO player, admin;

-- Handing over ----------------------------------------------------------------
SELECT acting_as(:'anna');
SELECT is(hand_over(:'annas', 'Ben') ->> 'offered_to', 'Ben', 'Anna hands her wallet to Ben');
SELECT ok(holds(:'annas'), 'and holds it until he takes it');
RESET ROLE;
SELECT acting_as(:'cara');
SELECT throws_ok(format($$SELECT take_item(%L, true)$$, :'annas'), '42501',
                 'nobody is handing you that', 'Cara cannot take it');
RESET ROLE;
SELECT acting_as(:'ben');
SELECT is(my_items() -> 1 ->> 'offered_by', 'Anna', 'Ben sees it being handed to him');
SELECT is(take_item(:'annas', true) ->> 'held', 'true', 'and takes it');
SELECT ok(holds(:'annas'), 'Ben holds it');
RESET ROLE;
SELECT acting_as(:'anna');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Ben', 1, '')$$, :'annas'), '42501',
                 'you do not hold that wallet', 'and Anna cannot spend it');

-- Dropping and picking up ------------------------------------------------------
RESET ROLE;
SELECT acting_as(:'ben');
SELECT is(drop_item(:'annas', 7.870, 46.300) ->> 'lying', 'true', 'Ben drops it off his land');
SELECT is(jsonb_array_length(items_near(7.870, 46.300)), 1, 'it lies there');
RESET ROLE;
SELECT acting_as(:'dora');
SELECT throws_ok(format($$SELECT pick_up(%L, 7.870, 46.300)$$, :'annas'), '42501',
                 'Verify first — Profile → Verify says how',
                 'a player who is not verified cannot hold a wallet');
RESET ROLE;
SELECT acting_as(:'cara');
SELECT throws_ok(format($$SELECT pick_up(%L, 7.871, 46.300)$$, :'annas'), '23514',
                 'that is 77 m away — walk up to it', 'nobody picks it up from afar');
SELECT is(pick_up(:'annas', 7.87001, 46.30001) ->> 'held', 'true', 'Cara, beside it, picks it up');
RESET ROLE;
SELECT acting_as(:'ben');
SELECT ok(NOT holds(:'annas'), 'and Ben holds it no more');

-- In a safe ------------------------------------------------------------------
RESET ROLE;
SELECT acting_as(:'cara');
SELECT is(drop_item(:'annas', 7.881, 46.291) ->> 'safe', 'true',
          'dropped on Ben''s land, it is in his safe');
SELECT throws_ok(format($$SELECT pick_up(%L, 7.881, 46.291)$$, :'annas'), '42501',
                 'that lies on somebody else''s land', 'and only those who may build there take it');

SELECT * FROM finish();
ROLLBACK;
