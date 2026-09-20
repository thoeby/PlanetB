-- Who shaped a land, and when (db/0176).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('shape176@example.com', 'password12') AS ben,
       register('cara176@example.com', 'password12') AS cara;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000176'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.ben, 14
FROM ids;

-- Ground nobody has shaped says so, rather than saying nothing.
SELECT is(shaping_of('00000000-0000-0000-0000-000000000176') ->> 'rev', '0',
    'a land nobody has shaped is at revision nought');
SELECT is(shaping_of('00000000-0000-0000-0000-000000000176') ->> 'times', '0',
    'and has been shaped no times');

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('e', 64), 'height_edit', 10, 'r32-v1');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM ids;
SELECT save_height_edit('00000000-0000-0000-0000-000000000176', repeat('e', 64), 0, NULL);

SELECT is(shaping_of('00000000-0000-0000-0000-000000000176') ->> 'rev', '1',
    'and one that has been says which revision it is at');
SELECT is(shaping_of('00000000-0000-0000-0000-000000000176') ->> 'mine', 'true',
    'the one who shaped it is told it was them');

-- And somebody else is told whose it was, not that it was theirs.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM ids;
SELECT is(shaping_of('00000000-0000-0000-0000-000000000176') ->> 'mine', 'false',
    'and anybody else is told it was not');

SELECT * FROM finish();
ROLLBACK;
