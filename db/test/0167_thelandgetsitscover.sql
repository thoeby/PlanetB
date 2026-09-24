-- A land's ground is its own (db/0167).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('cover167@example.com', 'password12') AS ben,
       register('boss167@example.com', 'password12') AS ann;
-- PLAN-identity.md: these players are verified people (db/0195).
INSERT INTO player_verification (player_id, state, method, how)
SELECT id, 'verified', 'manual', 'fixture' FROM auth.user ON CONFLICT DO NOTHING;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000167a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
CREATE TEMP TABLE land AS
SELECT '00000000-0000-0000-0000-0000000167a1'::uuid AS id;

SELECT is(jsonb_array_length(tile_lands(14, tile_x(7.862, 14), tile_y(46.286, 14))), 1,
          'the tile the land falls in is handed it');
SELECT is(jsonb_array_length(tile_lands(14, tile_x(8.5, 14), tile_y(46.9, 14))), 0,
          'and a tile nowhere near it is handed none');
SELECT isnt(one_land((SELECT id FROM land)) -> 'outline', NULL,
            'one_land is a land the way every panel reads one');

-- Invariant 2: which ground is somebody's is part of what a tile is built
-- from, and tile_world hands it over with the rest.
SELECT isnt(tile_world(14, tile_x(7.862, 14), tile_y(46.286, 14)) -> 'lands', NULL,
            'the compiler is told where the lands are');

-- Invariant 6: the cover is copied by the operator, at assignment, and by
-- nobody else.
SELECT throws_like($$SELECT copy_cover((SELECT id FROM land), '[]'::jsonb)$$,
    '%only an admin%', 'a player cannot put shapes on a land this way');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'admin')::text, true) FROM who;

CREATE TEMP TABLE shapes AS SELECT jsonb_build_array(jsonb_build_object(
    'kind', 'landuse', 'props', jsonb_build_object('landuse', 'forest'),
    'geom', st_asgeojson(st_makeenvelope(7.861, 46.2855, 7.862, 46.2865), 12)::jsonb)) AS js;

SELECT is(copy_cover((SELECT id FROM land), (SELECT js FROM shapes)) ->> 'copied', '1',
          'the operator copies the cover onto the land');
SELECT is((SELECT count(*) FROM feature f
           WHERE f.area_id = (SELECT id FROM land) AND f.kind = 'landuse'
             AND f.props ->> 'landuse' = 'forest'), 1::bigint,
          'and it is a feature of the land, in the world''s own words');
SELECT is((SELECT count(*) FROM feature f
           WHERE f.area_id = (SELECT id FROM land) AND f.props ? 'from_cover'), 1::bigint,
          'marked as having come from the cover');

-- Done once: a land that already has its cover is left alone, so assigning
-- twice or a tab that ran the tracing again cannot double it.
SELECT is(copy_cover((SELECT id FROM land), (SELECT js FROM shapes)) ->> 'already', 'true',
          'and a land that has it already is not given it twice');

SELECT finish();
ROLLBACK;
