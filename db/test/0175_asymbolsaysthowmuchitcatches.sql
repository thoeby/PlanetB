-- What a symbol catches, and which of its versions the world is built with
-- (db/0175). The matcher is client/lib/rules.js's, in SQL.
BEGIN;
SELECT plan(12);

SET client_min_messages = warning;

-- The comparisons, one at a time: as numbers where both sides are numbers,
-- as trimmed lower-case text otherwise.
SELECT ok(cond_holds('{"highway": "secondary"}',
    '{"prop": "highway", "op": "eq", "value": "Secondary"}'),
    'a word is compared without its case');
SELECT ok(cond_holds('{"lanes": "2"}', '{"prop": "lanes", "op": "gte", "value": 2}'),
    'a number written as text is still a number');
SELECT ok(NOT cond_holds('{"lanes": "2"}', '{"prop": "lanes", "op": "gt", "value": 2}'),
    'and two is not more than two');
SELECT ok(cond_holds('{}', '{"prop": "lit", "op": "missing"}'),
    'a property that is not there is missing');
SELECT ok(NOT cond_holds('{"lit": ""}', '{"prop": "lit", "op": "exists"}'),
    'and one that is there but empty does not exist');
SELECT ok(cond_holds('{"name": "Kantonsstrasse"}',
    '{"prop": "name", "op": "has", "value": "strasse"}'),
    'has looks inside the word');
SELECT ok(cond_holds('{"highway": "track"}',
    '{"prop": "highway", "op": "in", "value": ["track", "path"]}'),
    'in is any of them');
SELECT ok(NOT cond_holds('{"highway": "road"}', '{"prop": "highway", "op": "sideways"}'),
    'an operator the matcher does not know refuses rather than catching all');

CREATE TEMP TABLE ids AS
SELECT register('sym175@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000175'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom, props) VALUES
    ('00000000-0000-0000-0000-000000000175', 'highway',
     st_geomfromtext('LINESTRINGZ(7.881 46.291 650, 7.883 46.293 650)', 4326),
     '{"highway": "secondary", "lit": "yes"}'),
    ('00000000-0000-0000-0000-000000000175', 'highway',
     st_geomfromtext('LINESTRINGZ(7.884 46.291 650, 7.886 46.293 650)', 4326),
     '{"highway": "track"}'),
    ('00000000-0000-0000-0000-000000000175', 'building',
     st_geomfromtext('POINTZ(7.885 46.295 650)', 4326), '{}');

SELECT is(feature_matches('highway', '[]'::jsonb), 2::bigint,
    'a symbol with no conditions catches every feature of its kind');
SELECT is(feature_matches('highway',
    '[{"prop": "highway", "op": "eq", "value": "secondary"}]'::jsonb), 1::bigint,
    'and one with a condition catches what holds');
SELECT is(feature_matches('*', '[]'::jsonb),
    (SELECT count(*) FROM feature WHERE deleted_at IS NULL),
    'the kind that catches everything left catches everything');

-- Every symbol, with what the editor's list shows about it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT save_symbol(NULL, 'Kantonsstrasse', 'highway', 100,
    '[{"prop": "highway", "op": "eq", "value": "secondary"}]'::jsonb,
    '[{"layer": "surface", "params": {"width": 6}}]'::jsonb, true);

SELECT is((SELECT jsonb_build_array(s -> 'layer_count', s -> 'matches', s -> 'applied')
           FROM jsonb_array_elements(symbols_now()) AS s
           WHERE s ->> 'name' = 'Kantonsstrasse'),
    '[1, 1, null]'::jsonb,
    'one layer, one feature caught, and not in the world until somebody applies it');

SELECT * FROM finish();
ROLLBACK;
