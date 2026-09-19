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

-- The other three exist, with the shape they will keep, and refuse in one
-- sentence until F10 gives them a runner. A block wired to an address that
-- 404s cannot be validated; one wired to an address that says no can.
SELECT throws_like($$SELECT port_write(gen_random_uuid(), 'on', 'true'::jsonb)$$,
    '%flows do not run yet%', 'writing a port says flows do not run yet');
SELECT throws_like($$SELECT mover_set(gen_random_uuid(), '{}'::jsonb)$$,
    '%flows do not run yet%', 'so does setting a mover');
SELECT throws_like($$SELECT world_events(0)$$,
    '%flows do not run yet%', 'and so does asking what has happened');

SELECT has_function('api'::name, 'world_clock'::name,
                    'and every one of them is reachable over the API');

SELECT finish();
ROLLBACK;
