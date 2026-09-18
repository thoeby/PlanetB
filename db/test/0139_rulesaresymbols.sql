-- A rule is a symbol, and a symbol is layers (db/0139).
BEGIN;
SELECT plan(13);

SET client_min_messages = warning;

-- What the rules were, as symbols.
SELECT ok((SELECT count(*) FROM symbol WHERE kind = 'landuse') >= 10,
          'the species that were rules are symbols');
SELECT is((SELECT name FROM symbol WHERE kind = 'landuse' ORDER BY ordering, id LIMIT 1),
          'spruce', 'a named species is still tried before the catch-all');
SELECT is((SELECT s.layers -> 0 ->> 'layer' FROM symbol s WHERE s.name = 'any road'),
          'surface', 'a road is a surface along a line');
SELECT is((SELECT s.layers -> 0 ->> 'layer' FROM symbol s WHERE s.name = 'any building'),
          'extrude', 'a footprint is an outline pulled up');
SELECT is((SELECT s.layers -> 0 ->> 'layer' FROM symbol s WHERE s.name = 'any forest'),
          'scatter', 'a stand of trees is a scatter');
-- Water was written into the compiler and is a symbol now.
SELECT is((SELECT count(*)::int FROM symbol WHERE kind = 'natural' AND name = 'water'), 1,
          'and the water the compiler knew about is one too');

-- Invariant 2: a tile was built from a style, and the style is pinned.
SELECT is((SELECT count(*)::int FROM style_version), 1,
          'the rules, as they were, are the first applied style');
SELECT is(jsonb_array_length(pinned_symbols()),
          (SELECT count(*)::int FROM symbol WHERE enabled),
          'every enabled symbol is pinned by it');
SELECT is(jsonb_array_length(tile_world(14, 8500, 5700) -> 'symbols'),
          jsonb_array_length(pinned_symbols()),
          'and the compiler is handed exactly those');

-- Saving a symbol is a new version, and changes nothing anybody has published
-- until the styles are applied (FND.8).
CREATE TEMP TABLE before AS SELECT world_snapshot(14, 8500, 5700) AS snap,
    (SELECT id FROM symbol WHERE name = 'any road') AS road;
CREATE TEMP TABLE who AS SELECT register('ops139@example.com', 'password12') AS ops;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ops, 'role', 'admin')::text, true) FROM who;
SELECT is((SELECT save_symbol((SELECT road FROM before), 'any road', 'highway', 999,
    '[]'::jsonb, '[{"layer": "surface", "params": {"width": 7}}]'::jsonb, true) ->> 'version'),
    '2', 'a save is the next version');
SELECT is(world_snapshot(14, 8500, 5700), (SELECT snap FROM before),
          'and no tile has moved, because nothing has been applied');

-- A layer names a product of the right kind, or it does not save.
SELECT lives_ok($$SELECT check_layers(
    '[{"layer": "repeat", "params": {"segment": "SAAAAAAAAAAAA"}}]'::jsonb)$$,
    'a catalogue number this world has never seen is not this function''s business');

SELECT register_artifact(repeat('7', 64), 'material', 4096, 'material-v1');
CREATE TEMP TABLE mat AS SELECT register_asset(repeat('7', 64), 0::smallint,
    '{"name": "Asphalt", "type": "material", "px": 256, "tiling": 4}'::jsonb) AS san;
SELECT throws_like($$SELECT check_layers(jsonb_build_array(jsonb_build_object(
    'layer', 'repeat', 'params', jsonb_build_object('segment', (SELECT san FROM mat)))))$$,
    '%repeating piece%is a material%',
    'a repeat laid with a surface material is refused, and says why');

SELECT * FROM finish();
ROLLBACK;
