-- A function is executed by the roles it is granted to (db/0199).
BEGIN;
SELECT plan(5);

SELECT is((SELECT count(*)::int FROM pg_proc p
           WHERE p.pronamespace = 'api'::regnamespace
             AND (p.proacl IS NULL OR p.proacl::text ~ '(^|[{,])=X')),
          0, 'no api function is executable by PUBLIC');

SELECT ok(NOT has_function_privilege('anon', 'api.set_ground(text, text, float8, float8, float8, float8)', 'EXECUTE'),
          'anon cannot reach an admin write through PUBLIC');
SELECT ok(has_function_privilege('anon', 'api.login(text, text)', 'EXECUTE'),
          'anon can still sign in');
SELECT ok(has_function_privilege('flow', 'api.port_write(uuid, text, jsonb)', 'EXECUTE'),
          'a flow key can still write a port');

SELECT ok(NOT has_function_privilege('player', 'revive_job(bigint)', 'EXECUTE'),
          'a player — and so a QGIS login — cannot revive somebody''s job');

SELECT * FROM finish();
ROLLBACK;
