-- How deep the ground is cut is a number the world can be built at (db/0199).
BEGIN;
SELECT plan(5);

SELECT is(dem_deeper(14), 2, 'unset, a z14 tile is cut from z16, as db/0187 had it');
SELECT is(dem_deeper(16), 1, 'and a z16 tile one zoom deeper');
SET LOCAL splatworld.dem_deeper = '0';
SELECT is(dem_deeper(14), 0, 'set to nought, from its own cut');
SELECT is(world_size() #>> '{dem_deeper,set}', 'true', 'and the world says it is set');
SET LOCAL splatworld.dem_deeper = '9';
SELECT is(dem_deeper(14), 2, 'never deeper than two');

SELECT * FROM finish();
ROLLBACK;
