-- An artifact says where its bytes are, and a tab is offered only the atoms
-- it can build.
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land166@example.com', 'password12') AS owner_id,
       register('rend166@example.com', 'password12') AS worker_id;

-- The path travels with the first registration and stays there.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
SELECT register_artifact(repeat('a', 64), 'init_ply', 4096, 'assemble-v9',
                         '/jobs/7/' || repeat('a', 64) || '.ply');
SELECT is((SELECT path FROM artifact WHERE sha256 = repeat('a', 64)),
    '/jobs/7/' || repeat('a', 64) || '.ply', 'the first registration says where the bytes are');
SELECT register_artifact(repeat('a', 64), 'init_ply', 4096, 'assemble-v9',
                         '/jobs/9/' || repeat('a', 64) || '.ply');
SELECT is((SELECT path FROM artifact WHERE sha256 = repeat('a', 64)),
    '/jobs/7/' || repeat('a', 64) || '.ply', 'a second one does not move them (Invariant 1)');
SELECT register_artifact(repeat('b', 64), 'init_ply', 4096, 'assemble-v9');
SELECT is((SELECT path FROM artifact WHERE sha256 = repeat('b', 64)), null,
    'four arguments still register, without an address');
SELECT register_artifact(repeat('b', 64), 'init_ply', 4096, 'assemble-v9',
                         '/jobs/9/' || repeat('b', 64) || '.ply');
SELECT is((SELECT path FROM artifact WHERE sha256 = repeat('b', 64)),
    '/jobs/9/' || repeat('b', 64) || '.ply', 'and a later one may fill in the address');

-- A tab is offered the versions it builds and nothing else.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000166'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))', 4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000166', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS jid;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
SELECT is((SELECT id FROM claim_atom('{"algo": {"assemble": "assemble-v0"}}'::jsonb)), null,
    'a tab on other code is not handed the assemble');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND state = 'claimed'), 0,
    'and nothing was claimed for it');
SELECT is((SELECT op FROM claim_atom('{"algo": {"frame": "frame-v0"}}'::jsonb)), 'assemble',
    'a tab that builds this assemble is handed it, whatever it says about frames');
SELECT is((SELECT op FROM claim_atom('{}'::jsonb)), null,
    'and bare caps mean every version, which is the one already taken');

SELECT * FROM finish();
ROLLBACK;
