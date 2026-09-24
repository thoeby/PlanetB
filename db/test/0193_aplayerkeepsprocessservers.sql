-- A player keeps a list of process servers (db/0193).
BEGIN;
SELECT plan(10);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('ps193@example.com', 'password12') AS ben,
       register('ps193c@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
CREATE TEMP TABLE srv AS
SELECT save_process_server(null, 'alpha', 'http://127.0.0.1:8091/') AS id;
GRANT SELECT ON srv TO player;
SET LOCAL ROLE player;

SELECT isnt((SELECT id FROM srv), NULL, 'a player adds a server');
SELECT is((SELECT url FROM process_server WHERE name = 'alpha'),
          'http://127.0.0.1:8091', 'and it is kept without the trailing slash');
SELECT throws_like($$SELECT save_process_server(null, 'alpha', 'http://x:1')$$,
    '%already have a server called alpha%', 'two of one name are refused');
SELECT throws_like($$SELECT save_process_server(null, 'beta', 'ftp://x')$$,
    '%starts with http%', 'an address is http or https');
SELECT throws_like($$SELECT save_process_server(null, '  ', 'http://x:1')$$,
    '%needs a name%', 'and a server has a name');

SELECT lives_ok($$SELECT save_process_server(
    (SELECT id FROM process_server WHERE name = 'alpha'), 'alpha', 'http://127.0.0.1:8092')$$,
    'the owner changes its address');

RESET ROLE;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SET LOCAL ROLE player;

SELECT is((SELECT count(*) FROM process_server)::int, 0,
          'nobody else sees it (Invariant 6)');
SELECT throws_like($$SELECT save_process_server(
    (SELECT id FROM srv), 'mine', 'http://x:1')$$,
    '%not one of your servers%', 'or changes it');

RESET ROLE;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SET LOCAL ROLE player;
SELECT ok(delete_process_server((SELECT id FROM process_server WHERE name = 'alpha')),
          'the owner removes it');
SELECT is((SELECT count(*) FROM api.process_server)::int, 0, 'and it is gone');

SELECT finish();
ROLLBACK;
