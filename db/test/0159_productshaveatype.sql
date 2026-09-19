-- A product is not always a model (db/0159): what each type is made of, what
-- each type has to say about itself, and what a collection may hold.
BEGIN;
SELECT plan(12);

CREATE TEMP TABLE who AS
SELECT register('cal137@example.com', 'password12') AS cal,
       register('dev137@example.com', 'password12') AS dev;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cal, 'role', 'player')::text, true) FROM who;

-- One file of each kind, so the types have something to be made of.
SELECT register_artifact(repeat('1', 64), 'glb', 900, 'canon-v1');
SELECT register_artifact(repeat('2', 64), 'glb', 900, 'canon-v1');
SELECT register_artifact(repeat('3', 64), 'material', 4096, 'material-v1');
SELECT register_artifact(repeat('4', 64), 'profile', 200, 'profile-v1');
SELECT register_artifact(repeat('5', 64), 'collection', 200, 'collection-v1');
SELECT register_artifact(repeat('6', 64), 'glb', 900, 'canon-v1');

-- Registered first, read after: the row a function inserts is not in the
-- snapshot of the statement that called it.
CREATE TEMP TABLE sans AS SELECT
    register_asset(repeat('1', 64), 1::smallint,
        '{"name": "Bench", "bbox": {"min": [0,0,0], "max": [1.6,0.9,0.6]}}'::jsonb)
        AS bench,
    register_asset(repeat('2', 64), 1::smallint,
        ('{"name": "Wall 2 m", "type": "segment",'
         || '"bbox": {"min": [0,0,0], "max": [2,0.8,0.4]}}')::jsonb) AS wall,
    register_asset(repeat('3', 64), 0::smallint,
        '{"name": "Asphalt", "type": "material", "px": 256, "tiling": 4}'::jsonb)
        AS asphalt,
    register_asset(repeat('4', 64), 0::smallint,
        ('{"name": "Strasse 6 m", "type": "profile",'
         || '"profile": [{"offset": 0, "width": 6}]}')::jsonb) AS strasse;
GRANT SELECT ON sans TO player;

-- A model, which is what a product was until now.
SELECT is((SELECT type FROM asset WHERE san = (SELECT bench FROM sans)),
          'model', 'a product with no type is a model');

-- A repeating piece is measured along X, and one too short to repeat is not one.
SELECT is((SELECT type FROM asset WHERE san = (SELECT wall FROM sans)),
          'segment', 'a 2 m wall is a repeating piece');
SELECT throws_like(
    $$SELECT register_asset(repeat('6', 64), 1::smallint,
        ('{"name": "Crumb", "type": "segment",'
         || '"bbox": {"min": [0,0,0], "max": [0.05,0.1,0.1]}}')::jsonb)$$,
    '%at least 0.10 m long%', 'and 5 cm of one is not');

-- A material is a square png, a power of two, with a tiling size.
SELECT is((SELECT type FROM asset WHERE san = (SELECT asphalt FROM sans)),
          'material', 'a 256 px png with a tiling is a material');
SELECT throws_like(
    $$SELECT register_asset(repeat('3', 64), 0::smallint,
        '{"name": "Huge", "type": "material", "px": 3000, "tiling": 4}'::jsonb)$$,
    '%at most 2048 px%', 'and 3000 px of one is not');
SELECT throws_like(
    $$SELECT register_asset(repeat('3', 64), 0::smallint,
        '{"name": "Odd", "type": "material", "px": 300, "tiling": 4}'::jsonb)$$,
    '%power of two%', 'nor is 300');
SELECT throws_like(
    $$SELECT register_asset(repeat('3', 64), 0::smallint,
        '{"name": "Untiled", "type": "material", "px": 256}'::jsonb)$$,
    '%tiling size in metres%', 'nor one nobody said the size of');

-- A cross-section is the JSON that describes it, and it needs a strip.
SELECT is((SELECT type FROM asset WHERE san = (SELECT strasse FROM sans)),
          'profile', 'a cross-section with a strip is a cross-section');
SELECT throws_like(
    $$SELECT register_asset(repeat('4', 64), 0::smallint,
        '{"name": "Nothing", "type": "profile", "profile": []}'::jsonb)$$,
    '%at least one strip%', 'and one with none is not');

-- The file has to be of the kind the type is made of.
SELECT throws_like(
    $$SELECT register_asset(repeat('1', 64), 0::smallint,
        '{"name": "Not a png", "type": "material", "px": 256, "tiling": 4}'::jsonb)$$,
    '%no material artifact%', 'a material made of a glb is refused');

-- A collection holds models, and nothing else.
CREATE TEMP TABLE made AS
SELECT register_asset(repeat('5', 64), 0::smallint,
           '{"name": "Mischwald", "type": "collection"}'::jsonb) AS coll,
       (SELECT san FROM asset WHERE name = 'Bench') AS bench,
       (SELECT san FROM asset WHERE name = 'Asphalt') AS asphalt;
GRANT SELECT ON made TO player;

INSERT INTO collection_item (collection_san, member_san, weight)
SELECT coll, bench, 3 FROM made;
SELECT is((SELECT weight FROM collection_item), 3::numeric,
          'a model goes into a collection with its weight');
SELECT throws_like(
    $$INSERT INTO collection_item (collection_san, member_san)
      SELECT coll, asphalt FROM made$$,
    '%a collection holds models%', 'and a material does not');

SELECT * FROM finish();
ROLLBACK;
