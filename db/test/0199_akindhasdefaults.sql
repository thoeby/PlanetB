-- Kind defaults (db/0199): an admin sets them, setting again replaces them,
-- a player cannot, everybody reads them, and they go with their kind.
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE who AS
SELECT register('ada199@example.com', 'password12') AS ada,
       register('bob199@example.com', 'password12') AS bob;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ada, 'role', 'admin')::text, true) FROM who;
SELECT put_kind('hedgerow', 'feature', 'line');

SELECT is(put_kind_default('hedgerow', 1.5, true, 100, false), 'hedgerow',
          'an admin says a hedgerow is a metre and a half, cornered');
SELECT is((SELECT width FROM kind_default WHERE kind = 'hedgerow'), 1.5::real,
          'and the world holds it');
SELECT put_kind_default('hedgerow', 2, true, null, true);
SELECT is((SELECT count(*) FROM kind_default WHERE kind = 'hedgerow'), 1::bigint,
          'setting it again replaces the row');
SELECT ok((SELECT hidden FROM kind_default WHERE kind = 'hedgerow'),
          'hidden: the pickers leave it out');
SELECT throws_ok($$SELECT put_kind_default('hedgerow', -1)$$, '23514', NULL,
                 'a width is more than nothing');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT put_kind_default('hedgerow', 9)$$,
                   '%only an admin%', 'a player does not set what a kind is');

RESET ROLE;
DELETE FROM kind WHERE name = 'hedgerow';
SELECT is((SELECT count(*) FROM kind_default WHERE kind = 'hedgerow'), 0::bigint,
          'the defaults go with their kind');

SELECT * FROM finish();
ROLLBACK;
