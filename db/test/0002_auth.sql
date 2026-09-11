-- WP0.3 acceptance: register, login returns a token whose payload carries sub
-- and role, wrong password raises.
BEGIN;
SELECT plan(23);

SELECT has_schema('auth', 'schema auth');
SELECT has_table('auth', 'user', 'auth.user');
SELECT columns_are('auth', 'user',
    ARRAY['id', 'email', 'pw_hash', 'role', 'created_at']);
SELECT has_function('public', 'register', ARRAY['text', 'text'], 'register()');
SELECT has_function('public', 'login', ARRAY['text', 'text'], 'login()');
SELECT has_function('public', 'current_user_id', 'current_user_id()');
SELECT function_returns('public', 'current_user_id', 'uuid', 'returns uuid');

SELECT has_role('anon', 'role anon');
SELECT has_role('player', 'role player');
SELECT has_role('admin', 'role admin');

-- base64url round-trip (the JWT encoding, padding stripped)
SELECT is(convert_from(auth.b64url_decode(
        auth.b64url_encode(convert_to('{"sub":"x"}', 'utf8'))), 'utf8'),
    '{"sub":"x"}', 'base64url round-trips');

-- register ------------------------------------------------------------
-- The very first account is the admin: somebody has to be able to set the world
-- up and nobody can grant it to them (db/0039_ground.sql). Here that is the
-- installer, so the pilot below is the second account and an ordinary player.
SELECT lives_ok($$SELECT register('installer@example.com', 'hunter2hunter2')$$,
    'the first account is made');
SELECT is((SELECT role FROM auth.user WHERE email = 'installer@example.com'),
    'admin', 'and it is the admin');

SELECT lives_ok($$SELECT register('Pilot@example.com', 'hunter2hunter2')$$,
    'register succeeds');
SELECT is((SELECT role FROM auth.user WHERE email = 'pilot@example.com'),
    'player', 'everybody after them is a player');
SELECT is((SELECT email FROM auth.user WHERE email LIKE 'pilot%'),
    'pilot@example.com', 'email is normalised to lower case');
SELECT isnt((SELECT pw_hash FROM auth.user WHERE email = 'pilot@example.com'),
    'hunter2hunter2', 'password is not stored in clear');
SELECT is((SELECT count(*)::int FROM account
           WHERE owner_id = (SELECT id FROM auth.user WHERE email = 'pilot@example.com')),
    1, 'register creates exactly one account');
SELECT throws_ok($$SELECT register('pilot@example.com', 'hunter2hunter2')$$,
    '23505', null, 'duplicate email rejected');
SELECT throws_ok($$SELECT register('other@example.com', 'short')$$, null,
    'short password rejected');

-- login ---------------------------------------------------------------
SELECT is(
    (SELECT auth.verify(login('pilot@example.com', 'hunter2hunter2')) ->> 'sub'),
    (SELECT id::text FROM auth.user WHERE email = 'pilot@example.com'),
    'token payload carries sub');
SELECT is(
    (SELECT auth.verify(login('pilot@example.com', 'hunter2hunter2')) ->> 'role'),
    'player', 'token payload carries role');
SELECT throws_ok($$SELECT login('pilot@example.com', 'wrongpassword')$$,
    '28P01', null, 'wrong password raises');

SELECT * FROM finish();
ROLLBACK;
