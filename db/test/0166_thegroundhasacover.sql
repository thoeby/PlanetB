-- The ground's cover: sources, the mapping, and the moment it reaches the
-- world (db/0166).
BEGIN;
SELECT plan(13);

SET client_min_messages = warning;
-- As PostgREST calls them: `api` ahead of `public`.
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('cover166@example.com', 'password12') AS ben,
       register('boss166@example.com', 'password12') AS ann;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'admin')::text, true) FROM who;

SELECT is(jsonb_array_length(cover_draft()), 0, 'a world with no cover says so');
SELECT is(jsonb_array_length(pinned_cover()), 0, 'and is built with none');
SELECT is(jsonb_array_length(style_changes()), 0, 'with nothing waiting to be applied');

CREATE TEMP TABLE src AS
SELECT set_ground_layer('cover', 'http://gs.example/geoserver', 'splatworld:tlm',
    7.85, 46.28, 7.91, 46.31, 0) AS id;

SELECT is(jsonb_array_length(cover_draft()), 1, 'a cover source is a ground layer');
SELECT is(cover_draft() -> 0 ->> 'layer', 'splatworld:tlm', 'named by its layer');

-- What a class means is the operator's word, in the world's own vocabulary.
SELECT set_cover_map((SELECT id FROM src), jsonb_build_object(
    '#22a12a', jsonb_build_object('kind', 'landuse', 'key', 'landuse',
                                  'value', 'forest', 'source_value', 'Wald')));

SELECT is(cover_draft() -> 0 -> 'class_map' -> '#22a12a' ->> 'value', 'forest',
          'the mapping is kept on the source');
SELECT is(jsonb_array_length(pinned_cover()), 0,
          'and saving it does not move the world');
SELECT is(style_changes() -> 0 ->> 'kind', 'cover',
          'but it is listed as waiting to be applied');

-- Invariant 6: only an admin maps a class, like everything else about the
-- ground (db/0106).
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT set_cover_map((SELECT id FROM src), '{}'::jsonb)$$,
    '%only an admin%', 'a player cannot map a class');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'admin')::text, true) FROM who;

-- Invariant 2: a tile is built with the mapping a style pinned, not with
-- whatever the panel has been doing since.
CREATE TEMP TABLE was AS
SELECT p.cover_mapping AS at FROM style_version p
WHERE p.id = (SELECT max(id) FROM style_version);
CREATE TEMP TABLE applied AS SELECT apply_styles('the cover') AS said;
SELECT cmp_ok((SELECT (said ->> 'cover_mapping')::int FROM applied), '>',
    (SELECT at FROM was), 'applying pins a new version of the mapping');
SELECT is(pinned_cover() -> 0 -> 'class_map' -> '#22a12a' ->> 'value', 'forest',
          'and that is what the world is built with');
SELECT is(jsonb_array_length(style_changes()), 0, 'with nothing left waiting');
SELECT is(tile_world(14, tile_x(7.88, 14), tile_y(46.29, 14)) -> 'cover' -> 0 ->> 'layer',
          'splatworld:tlm', 'and every tile is handed it');

SELECT finish();
ROLLBACK;
