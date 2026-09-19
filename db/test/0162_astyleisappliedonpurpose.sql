-- A style reaches the world when somebody says so (db/0162).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE who AS SELECT register('ops140@example.com', 'password12') AS ops;
GRANT SELECT ON who TO player;

-- Nothing has been saved since the migration pinned every symbol.
SELECT is(jsonb_array_length(style_changes()), 0,
          'a world nobody has edited has nothing waiting to be applied');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ops, 'role', 'admin')::text, true) FROM who;

CREATE TEMP TABLE road AS SELECT id FROM symbol WHERE name = 'any road';
SELECT save_symbol((SELECT id FROM road), 'any road', 'highway', 999, '[]'::jsonb,
    '[{"layer": "surface", "params": {"width": 7}}]'::jsonb, true);

SELECT is(jsonb_array_length(style_changes()), 1,
          'a saved symbol is one symbol waiting');
SELECT is(style_changes() -> 0 ->> 'name', 'any road', 'and it says which');
SELECT is((style_changes() -> 0 ->> 'tiles')::int, 0,
          'no published tile holds a road in this world, so none would be rebuilt');

-- Saved is not built with: the world is still on the version it was applied at.
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(pinned_symbols()) p
           WHERE p ->> 'name' = 'any road'
             AND p -> 'layers' -> 0 -> 'params' ->> 'width' = '7'), 0,
          'a saved symbol is not what the world is built with');

-- Applying is what moves the world.
CREATE TEMP TABLE before AS SELECT max(id) AS style FROM style_version;
CREATE TEMP TABLE got AS SELECT apply_styles('a wider road') AS out;
SELECT is((SELECT (out ->> 'symbols')::int FROM got), 1,
          'applying says how many symbols went in');
SELECT ok((SELECT (out ->> 'style_version')::int FROM got) > (SELECT style FROM before),
          'and pins a new style version');
SELECT is(jsonb_array_length(style_changes()), 0,
          'after which nothing is waiting');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(pinned_symbols()) p
           WHERE p ->> 'name' = 'any road'
             AND p -> 'layers' -> 0 -> 'params' ->> 'width' = '7'), 1,
          'and the world is built with the road as it was saved');

SELECT * FROM finish();
ROLLBACK;
