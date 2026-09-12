-- Drawing land is enough to have something to compile.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('ground@example.com', 'password12') AS owner_id;

SELECT is((SELECT count(*)::int FROM tile WHERE z = 14), 0,
    'nothing at the baseline yet');

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-00000000ab01'::uuid,
       st_geomfromtext('POLYGON((7 46,7.02 46,7.02 46.02,7 46.02,7 46))', 4326),
       ids.owner_id, 14
FROM ids;

SELECT cmp_ok((SELECT count(*)::int FROM tile WHERE z = 14), '>', 0,
    'drawing land makes the tiles that cover it');
SELECT ok((SELECT bool_and(dirty) FROM tile),
    'and every one of them is waiting to be compiled');
SELECT ok(EXISTS (SELECT 1 FROM tile WHERE z = 6),
    'the ladder above it is there too');

-- Moving the boundary leaves ground behind and takes ground on: both ends are
-- dirty, so what was there stops being what is shown.
UPDATE tile SET dirty = false, expected_version = 1;
UPDATE area SET geom = st_geomfromtext(
    'POLYGON((7.04 46,7.06 46,7.06 46.02,7.04 46.02,7.04 46))', 4326)
WHERE id = '00000000-0000-0000-0000-00000000ab01';
SELECT cmp_ok((SELECT count(*)::int FROM tile WHERE dirty AND z = 14), '>=', 2,
    'moving it dirties where it was and where it now is');

SELECT * FROM finish();
ROLLBACK;
