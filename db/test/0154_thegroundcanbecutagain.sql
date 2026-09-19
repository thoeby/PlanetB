-- The ground can be cut again: an admin forgets every cut, the ground's own
-- mark moves, and what is already compiled is left alone.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('recut154@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.88, 46.30);
SELECT compile_ground();

-- Two tiles that have been cut, and a mark from before the recut.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'dem', 1024, 'dem-v1'),
       (repeat('b', 64), 'dem', 1024, 'dem-v1');
INSERT INTO geo_tile (z, x, y, sha256)
VALUES (14, 8557, 5736, repeat('a', 64)), (12, 2139, 1434, repeat('b', 64));
-- Aged by an hour first: `set_ground` above and `recut_ground` below both
-- write `now()`, which is the transaction's own timestamp and does not move
-- inside one. What is being tested is that the recut writes the mark, so the
-- mark it is compared against has to be older than this transaction.
UPDATE ground SET set_at = now() - interval '1 hour';
CREATE TEMP TABLE before AS SELECT set_at, (SELECT count(*) FROM job) AS jobs FROM ground;

CREATE TEMP TABLE said AS SELECT recut_ground() AS out;
SELECT is(((SELECT out FROM said) ->> 'forgotten')::int, 2, 'both cuts are forgotten');
SELECT is((SELECT count(*) FROM geo_tile), 0::bigint, 'and nothing says it is cut');
SELECT ok((SELECT set_at FROM ground) > (SELECT set_at FROM before),
    'the ground''s own mark moves, which is what a stale cut is compared against');
SELECT is((SELECT count(*) FROM job), (SELECT jobs FROM before),
    'nothing is queued: rendering the ground again is its own decision');

-- A player may not do it, and a world with no ground has nothing to cut.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok('SELECT recut_ground()', '42501',
    'only an admin cuts the world again', 'a player cannot cut the world again');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
DELETE FROM ground;
SELECT throws_ok('SELECT recut_ground()', 'there is no ground to cut',
    'and a world with no ground has none to forget');

SELECT * FROM finish();
ROLLBACK;
