-- A flow is a pointer to an ELX file on a land (db/0155): who may save one,
-- what the compare-and-swap on `rev` stops, and what is refused.
BEGIN;
SELECT plan(15);

CREATE TEMP TABLE who AS
SELECT register('ann133@example.com', 'password12') AS ann,
       register('bo133@example.com', 'password12') AS bo,
       register('cy133@example.com', 'password12') AS cy;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-000000000133'::uuid,
       st_makeenvelope(7.80, 46.20, 7.81, 46.21, 4326), ann, 14,
       '{"name": "Bergli"}'::jsonb
FROM who;

-- The ELX is a file like any other: PUT, registered, then pointed at.
SELECT register_artifact(repeat('a', 64), 'flow', 120, 'elx-v1');
SELECT register_artifact(repeat('b', 64), 'flow', 140, 'elx-v1');
SELECT register_artifact(repeat('c', 64), 'glb', 900, 'glb-v1');

CREATE TEMP TABLE saved AS
SELECT save_flow(NULL, '00000000-0000-0000-0000-000000000133', 'lamp at dusk',
                 repeat('a', 64), '{"elx-layout::x::": "{}"}'::jsonb, 0) AS r;
GRANT SELECT ON saved TO player;

SELECT is((SELECT (r ->> 'rev')::bigint FROM saved), 1::bigint,
          'a new flow starts at rev 1');
SELECT is((SELECT count(*) FROM flow WHERE area_id = '00000000-0000-0000-0000-000000000133'),
          1::bigint, 'and it is on the land');
SELECT is((SELECT layout ->> 'elx-layout::x::' FROM flow),
          '{}', 'the layout is kept beside the pointer, not in the ELX');

-- Invariant 1: the pointer moves to a new file, the old file stays.
SELECT is((SELECT (save_flow((SELECT (r ->> 'id')::uuid FROM saved),
                             '00000000-0000-0000-0000-000000000133', 'lamp at dusk',
                             repeat('b', 64), '{}'::jsonb, 1) ->> 'rev')::bigint),
          2::bigint, 'saving again lifts the rev');
SELECT throws_like(
    $$SELECT save_flow((SELECT (r ->> 'id')::uuid FROM saved),
                       '00000000-0000-0000-0000-000000000133', 'lamp at dusk',
                       repeat('b', 64), '{}'::jsonb, 1)$$,
    '%changed in another tab%', 'a stale tab is told to reload, not obeyed');
SELECT throws_like(
    $$SELECT save_flow(NULL, '00000000-0000-0000-0000-000000000133', 'from a .glb',
                       repeat('c', 64), '{}'::jsonb, 0)$$,
    '%not a flow file%', 'a sha that is not a registered flow is refused');
SELECT throws_like(
    $$SELECT save_flow(NULL, '00000000-0000-0000-0000-000000000133', 'lamp at dusk',
                       repeat('a', 64), '{}'::jsonb, 0)$$,
    '%already used on this land%', 'and two flows on one land cannot share a name');

-- Somebody with nothing on this land sees nothing and writes nothing.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', bo, 'role', 'player')::text, true) FROM who;
-- Read is decided by the policy, so it is asked as `player` rather than as the
-- superuser the suite runs as, who is not subject to one.
SET LOCAL ROLE player;
SELECT is((SELECT count(*) FROM flow), 0::bigint,
          'somebody with no rights on the land sees no flows');
RESET ROLE;
SELECT throws_like(
    $$SELECT save_flow(NULL, '00000000-0000-0000-0000-000000000133', 'mine now',
                       repeat('a', 64), '{}'::jsonb, 0)$$,
    '%do not build on that land%', 'and cannot put one there');

-- A build grantee reads and writes.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'player')::text, true) FROM who;
INSERT INTO grant_ (area_id, grantee_id, right_)
SELECT '00000000-0000-0000-0000-000000000133', cy, 'direct_edit' FROM who;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cy, 'role', 'player')::text, true) FROM who;
SET LOCAL ROLE player;
SELECT is((SELECT count(*) FROM flow), 1::bigint, 'a build grantee sees the flow');
RESET ROLE;
SELECT is((SELECT (save_flow((SELECT (r ->> 'id')::uuid FROM saved),
                             '00000000-0000-0000-0000-000000000133', 'lamp at dawn',
                             repeat('a', 64), '{}'::jsonb, 2) ->> 'rev')::bigint),
          3::bigint, 'and may save it');

-- Deleting is for everybody on the land, and the file stays.
SELECT ok(delete_flow((SELECT (r ->> 'id')::uuid FROM saved), 3),
          'a flow is deleted');
SELECT is((SELECT count(*) FROM flow WHERE deleted_at IS NULL), 0::bigint,
          'and is gone for everybody');
SELECT is((SELECT count(*) FROM artifact WHERE sha256 = repeat('a', 64)), 1::bigint,
          'while the ELX file it pointed at stays where it is');

-- Only an admin says what the palette is.
SELECT throws_like(
    $$SELECT bundle_plugins('[]'::jsonb)$$,
    '%only an admin%', 'a player does not bundle plugins');

SELECT * FROM finish();
ROLLBACK;
