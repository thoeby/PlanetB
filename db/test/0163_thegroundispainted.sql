-- The ground a player shaped (db/0163).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE who AS
SELECT register('shaper@example.com', 'password12') AS ben,
       register('other141@example.com', 'password12') AS ott;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000141a1'::uuid,
    st_setsrid(st_makeenvelope(7.8, 46.29, 7.804, 46.292), 4326), who.ben, 14
FROM who;
CREATE TEMP TABLE land AS
SELECT '00000000-0000-0000-0000-0000000141a1'::uuid AS id;

SELECT register_artifact(repeat('e', 64), 'height_edit', 4096, 'r32-v1');
SELECT register_artifact(repeat('f', 64), 'height_edit', 4096, 'r32-v1');

SELECT is((SELECT sha256 FROM current_height_edit((SELECT id FROM land))), NULL,
          'a land nobody has shaped has no grid');

SELECT is(save_height_edit((SELECT id FROM land), repeat('e', 64), 0) ->> 'rev', '1',
          'the first save is revision one');
SELECT is((SELECT sha256 FROM current_height_edit((SELECT id FROM land))), repeat('e', 64),
          'and that is what the land is shaped by');

-- Invariant 3's rule, on a land rather than a tile: two tabs cannot overwrite
-- each other silently.
SELECT throws_like($$SELECT save_height_edit((SELECT id FROM land), repeat('f', 64), 0)$$,
    '%shaped in another tab%',
    'a save from a stale revision is refused in words');

SELECT is(save_height_edit((SELECT id FROM land), repeat('f', 64), 1) ->> 'rev', '2',
          'and from the current one it goes through');

-- Invariant 6: shaping a land is building on it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ott, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT save_height_edit((SELECT id FROM land), repeat('e', 64), 2)$$,
    '%only shape your own land%', 'somebody else cannot shape this land');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

-- What the compiler is handed, and what it is measured against.
SELECT is(jsonb_array_length(height_edits(14, tile_x(7.802, 14), tile_y(46.291, 14))), 1,
          'the tile the land falls in is handed one shaped land');
SELECT is((SELECT submission_changes((SELECT id FROM land)) ->> 'ground'), '2',
          'and the Submit dialog says the ground moved');

-- Invariant 2: a tile built before the ground moved cannot publish over it.
CREATE TEMP TABLE snaps AS
SELECT world_snapshot(14, tile_x(7.802, 14), tile_y(46.291, 14)) AS before;
SELECT save_height_edit((SELECT id FROM land), repeat('e', 64), 2);
SELECT isnt(world_snapshot(14, tile_x(7.802, 14), tile_y(46.291, 14)),
            (SELECT before FROM snaps),
            'shaping the ground moves every snapshot the land touches');

SELECT * FROM finish();
ROLLBACK;
