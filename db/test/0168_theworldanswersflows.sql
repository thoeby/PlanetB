-- The four things a flow may ask the world (db/0168).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('flow168@example.com', 'password12') AS ben;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

-- The clock answers. Everything that moves by it moves by this one, and there
-- is nothing to withhold about what the time is.
SELECT ok(world_clock() > 1700000000, 'the world says what time it is');
SELECT ok(abs(world_clock() - extract(epoch FROM now())) < 1,
          'and it is this world''s own clock, not a guess');

-- The other three existed here with the shape they will keep, refusing every
-- caller in one sentence: a block wired to an address that 404s cannot be
-- validated; one wired to an address that says no can.
--
-- Two of them have since been given their real answer — `port_write` by FND.15
-- (db/0169) and `mover_set` by FND.16 (db/0172) — so what they say now is what
-- is wrong with the call, which is the better sentence and the point of having
-- written them. `world_events` answers since LV.2 (db/0203): somebody with
-- no land is told that nothing happened on it.
SELECT throws_like($$SELECT port_write(gen_random_uuid(), 'on', 'true'::jsonb)$$,
    '%standing anywhere%', 'writing a port answers a player now (FND.15)');
SELECT throws_like($$SELECT mover_set(gen_random_uuid(), '{}'::jsonb)$$,
    '%no such mover%', 'and so does setting a mover (FND.16)');
SELECT is(world_events(0) -> 'events', '[]'::jsonb,
    'and so does reading what happened (LV.2)');

SELECT has_function('api'::name, 'world_clock'::name,
                    'and every one of them is reachable over the API');

SELECT finish();
ROLLBACK;
