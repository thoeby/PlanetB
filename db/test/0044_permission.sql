-- TASKS-usable T7 acceptance: a rendered tile waits on the tile as a candidate;
-- the owner of the land under it, or whoever they granted `approve` to, looks at
-- it and publishes it or refuses it with a note. Nobody else sees it, and nobody
-- else gets to decide.
--
-- db/test/0017_verify.sql covers the approve path and what replaced the
-- perceptual gate. This is the rest: refuse, the grantee, and what the panel
-- asks for (my_candidates).
BEGIN;
SELECT plan(21);

SET client_min_messages = warning;

-- The first account registered is the admin (db/0039_ground.sql), and an admin
-- may approve anything — so it is somebody who does not appear again.
CREATE TEMP TABLE ids AS
SELECT register('first@example.com', 'password12') AS admin_id,
       register('owner@example.com', 'password12') AS owner_id,
       register('render@example.com', 'password12') AS worker_id,
       register('friend@example.com', 'password12') AS friend_id,
       register('passer@example.com', 'password12') AS stranger_id;

SELECT has_function('public', 'may_approve_tile',
    ARRAY['integer', 'integer', 'integer'], 'may_approve_tile()');

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000b7'::uuid,
       st_geomfromtext('POLYGON((8.4 47.4,8.6 47.4,8.6 47.6,8.4 47.6,8.4 47.4))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000b7', 'footprint',
        st_geomfromtext('POINTZ(8.5 47.5 450)', 4326));

CREATE TEMP TABLE tt AS SELECT t.z, t.x, t.y FROM tile t WHERE t.z = 14
ORDER BY t.x, t.y LIMIT 1;
GRANT SELECT ON tt TO player;

-- rendered by a stranger's browser ----------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
SELECT is(submit_atom((claim_atom('{}'::jsonb)).id,
    register_artifact(repeat('a', 64), 'init_ply', 512, 'assemble-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb), 'verified', 'assembled');
SELECT is(submit_atom((claim_atom('{}'::jsonb)).id,
    register_artifact(repeat('b', 64), 'ply', 1024, 'sample-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb), 'verified', 'sampled');
SELECT is(submit_atom((claim_atom('{}'::jsonb)).id,
    register_artifact(repeat('c', 64), 'sog', 2048, 'sog-v1'),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 2,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb), 'verified', 'encoded');
SELECT ok(publish_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt), 1,
    repeat('c', 64), '{"origin": {"lon": 8.5, "lat": 47.5, "h": 450}}'::jsonb),
    'the renderer puts it forward');

-- what the panel asks for -------------------------------------------------
SELECT is(jsonb_array_length(my_candidates()), 0,
    'the renderer is not asked to approve their own work');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', stranger_id, 'role', 'player')::text, true) FROM ids;
SELECT is(jsonb_array_length(my_candidates()), 0,
    'a passer-by is shown nothing waiting');
SELECT throws_ok(
    format($$SELECT refuse_tile(%s, %s, %s, 'no')$$,
           (SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)),
    '42501', null, 'and cannot refuse somebody else''s land');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT is(jsonb_array_length(my_candidates()), 1,
    'the owner of the land is shown the one waiting');
SELECT is((my_candidates() -> 0 ->> 'z')::int, (SELECT z::int FROM tt),
    'with the tile it is waiting on');
SELECT is((my_candidates() -> 0 ->> 'was_published')::boolean, false,
    'and whether it would replace something');

-- no ----------------------------------------------------------------------
SELECT ok(refuse_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt),
    'the roof is in the wrong place'), 'the owner refuses it');
SELECT is((SELECT t.refused_note FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y),
    'the roof is in the wrong place', 'the note is left for whoever rendered it');
SELECT is((SELECT t.candidate_sha256 FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y), null,
    'nothing is waiting any more');
SELECT is((SELECT t.published_version FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y), 0::bigint,
    'what was published is untouched');
SELECT ok((SELECT t.dirty FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y),
    'and the tile is dirty again, so it can be tried');
SELECT ok(NOT refuse_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)),
    'refusing nothing is a no-op');

-- somebody the owner trusts ----------------------------------------------
INSERT INTO grant_ (area_id, grantee_id, right_)
SELECT '00000000-0000-0000-0000-0000000000b7', ids.friend_id, 'approve' FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(publish_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt), 1,
    repeat('c', 64), '{"origin": {"lon": 8.5, "lat": 47.5, "h": 450}}'::jsonb),
    'it is rendered again and put forward again');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', friend_id, 'role', 'player')::text, true) FROM ids;
SELECT is(jsonb_array_length(my_candidates()), 1,
    'whoever was granted approve is shown it too');
SELECT ok(approve_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)),
    'and may say yes');
SELECT is((SELECT t.sog_sha256 FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y), repeat('c', 64),
    'what was waiting is what everybody now sees');

SELECT * FROM finish();
ROLLBACK;
