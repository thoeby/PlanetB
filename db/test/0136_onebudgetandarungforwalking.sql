-- One budget at every zoom, and a rung for where people walk.
BEGIN;
SELECT plan(7);

SELECT is(tile_budget(14), 600000::bigint, 'a z14 tile holds 600 000');
SELECT is(tile_budget(18), 600000::bigint, 'and so does a z18: the ladder is even');
SELECT is(tile_budget(20), 600000::bigint, 'and the new rung');
SELECT is(tile_budget(6), 600000::bigint, 'and the coarsest merged one');

SELECT is(camera_views(20), 81, 'z20 is framed from the stations and rings of z16-v3');

-- The rung exists in the ladder, and in what a land may ask to be compiled to.
SELECT lives_ok($$ INSERT INTO tile (z, x, y) VALUES (20, 547456, 371200) $$,
    'a z20 tile is a tile the world may hold');
SELECT throws_ok($$ INSERT INTO tile (z, x, y) VALUES (22, 1, 1) $$, '23514', NULL,
    'and z22 is not, until somebody decides it is');

SELECT * FROM finish();
ROLLBACK;
