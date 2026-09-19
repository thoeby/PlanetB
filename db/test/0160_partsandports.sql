-- A model can have parts, and a part can be told things (db/0160): the same
-- file marked two ways is two products, the markings are checked, and the
-- compiler is handed them.
BEGIN;
SELECT plan(12);

CREATE TEMP TABLE who AS
SELECT register('lamp138@example.com', 'password12') AS cal;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cal, 'role', 'player')::text, true) FROM who;

SELECT register_artifact(repeat('a', 64), 'glb', 900, 'canon-v1');
SELECT register_artifact(repeat('b', 64), 'glb', 900, 'canon-v2');
SELECT register_artifact(repeat('c', 64), 'material', 4096, 'material-v1');

-- --------------------------------------------------------------- the text

SELECT is(marks_text('{}'::jsonb), '',
    'a model nobody marked has no markings to hash');

SELECT is(
    marks_text(('{"parts": [{"name": "head", "node": "head", "role": "light"}],'
        || '"ports": [{"name": "on", "type": "boolean", "default": "false",'
        || '"drives": {"part": "head", "what": "light"}}]}')::jsonb),
    E'part:head:head:light:#ffd9a0:1.000\nport:on:boolean:false:head.light\n',
    'the canonical text is one line per marking, in one order');

-- The same markings typed in the other order, with the numbers spelt
-- differently: one product, or the catalog fills up with duplicates.
SELECT is(
    marks_text(('{"parts": [{"name": "mouth", "node": "mouth", "role": "door",'
        || '"axis": "y", "range": 90}, {"name": "head", "node": "head",'
        || '"role": "light", "intensity": 1}]}')::jsonb),
    marks_text(('{"parts": [{"name": "head", "node": "head", "role": "light",'
        || '"intensity": "1.000"}, {"name": "mouth", "node": "mouth",'
        || '"role": "door", "range": "90.0"}]}')::jsonb),
    'the order it was typed in and the way a number was spelt do not matter');

-- ------------------------------------------------------------- the number

SELECT is(marked_sha(repeat('a', 64), '{}'::jsonb), repeat('a', 64),
    'an unmarked model is named by its file alone, as canon-v1 named it');

SELECT isnt(
    marked_sha(repeat('a', 64),
        '{"parts": [{"name": "head", "node": "head", "role": "light"}]}'::jsonb),
    repeat('a', 64), 'a marked one is named by the file and the markings');

SELECT is(
    asset_name_for(repeat('a', 64),
        '{"parts": [{"name": "head", "node": "head", "role": "light"}]}'::jsonb),
    derive_san(marked_sha(repeat('a', 64),
        '{"parts": [{"name": "head", "node": "head", "role": "light"}]}'::jsonb)),
    'the form can ask for the number before it uploads anything');

-- --------------------------------------------------------- what is refused

SELECT throws_ok($$SELECT check_marks(
    '{"parts": [{"name": "head", "node": "head", "role": "glows"}]}'::jsonb)$$,
    NULL, 'head needs a role', 'a part needs a role the world knows');

SELECT throws_ok($$SELECT check_marks(
    '{"parts": [{"name": "a b", "node": "head", "role": "light"}]}'::jsonb)$$,
    NULL, '"a b" is not a name a part may have', 'a part is named in one word');

SELECT throws_ok($$SELECT check_marks(
    ('{"parts": [{"name": "head", "node": "head", "role": "light"}],'
     || '"ports": [{"name": "on", "type": "boolean",'
     || '"drives": {"part": "foot"}}]}')::jsonb)$$,
    NULL, 'on drives foot, which is not a part',
    'a port drives a part of this model or nothing');

SELECT throws_ok($$SELECT register_asset(repeat('c', 64), 0::smallint,
    ('{"name": "Asphalt", "type": "material", "px": 256, "tiling": 4,'
     || '"parts": {"parts": [{"name": "head", "node": "head",'
     || '"role": "light"}]}}')::jsonb)$$,
    NULL, 'only a model has parts; this is a material',
    'a surface material has no head to light up');

-- ------------------------------------------------ two products, one file

CREATE TEMP TABLE sans AS SELECT
    register_asset(repeat('b', 64), 2::smallint,
        '{"name": "Lampe"}'::jsonb) AS plain,
    register_asset(repeat('b', 64), 2::smallint,
        ('{"name": "Lampe mit Licht", "parts": {"parts": [{"name": "head",'
         || '"node": "head", "role": "light"}], "ports": [{"name": "on",'
         || '"type": "boolean", "default": "false", "drives": {"part": "head",'
         || '"what": "light"}}]}}')::jsonb) AS lit;

SELECT isnt((SELECT plain FROM sans), (SELECT lit FROM sans),
    'the same file marked and unmarked is two products');

SELECT is(
    (SELECT parts #>> '{ports,0,name}' FROM asset WHERE san = (SELECT lit FROM sans)),
    'on', 'and the marked one keeps what it was told');

SELECT * FROM finish();
ROLLBACK;
