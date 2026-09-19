-- The operator's settings (db/0156): who may change one, what an empty value
-- means, and that everybody can read them.
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE who AS
SELECT register('ada134@example.com', 'password12') AS ada,
       register('bob134@example.com', 'password12') AS bob;
GRANT SELECT ON who TO player;

-- What a caller may do is their role, and the role is on the token they came
-- with (db/0002 current_user_role).
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ada, 'role', 'admin')::text, true) FROM who;

SELECT is(set_app_setting('elx_url', 'http://localhost:8088'),
          'http://localhost:8088', 'an admin says where flows are checked');
SELECT is(app_settings() ->> 'elx_url', 'http://localhost:8088',
          'and the world answers with it');
SELECT is(set_app_setting('elx_url', '  http://elsewhere:9000 '),
          'http://elsewhere:9000', 'setting it again moves it, trimmed');
SELECT is((SELECT count(*) FROM app_setting), 1::bigint, 'one row, not two');
SELECT is(set_app_setting('elx_url', ''), '',
          'an empty value is "there is no such server"');
SELECT is((SELECT count(*) FROM app_setting), 0::bigint, 'and the row is gone');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'player')::text, true) FROM who;
SELECT throws_like(
    $$SELECT set_app_setting('elx_url', 'http://mine:1')$$,
    '%only an admin%', 'a player does not point the world at their own server');

SELECT * FROM finish();
ROLLBACK;
