-- A permit comes before building (db/0068_approvalfirst.sql, db/0069_approvalverbs.sql).
--
-- Submitting asks; approving opens the render jobs; a render publishes when it
-- lands. This replaces db/test/0044_permission.sql, which was the same story
-- in the other order — render first, approve the picture afterwards.
BEGIN;
SELECT plan(17);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('first68@example.com', 'password12') AS admin_id,
       register('owner68@example.com', 'password12') AS owner_id,
       register('ben68@example.com', 'password12') AS ben_id,
       register('passer68@example.com', 'password12') AS stranger_id;

DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
SELECT 'http://localhost:8081/geoserver', 'test:ground',
       st_makeenvelope(8.3, 47.3, 8.7, 47.7, world_srid()), ids.admin_id FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000c8'::uuid,
       st_geomfromtext('POLYGON((8.4 47.4,8.6 47.4,8.6 47.6,8.4 47.6,8.4 47.4))',
                       world_srid()),
       ids.owner_id, 14
FROM ids;

-- Claiming land renders nothing (db/0064), so there is nothing to submit until
-- something is drawn on it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_like($$SELECT submit_area('00000000-0000-0000-0000-0000000000c8')$$,
    '%nothing to submit%', 'empty land has nothing to submit');

INSERT INTO feature (area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000c8', 'forest',
       st_force3d(st_geomfromtext(
           'POLYGON((8.45 47.45,8.46 47.45,8.46 47.46,8.45 47.46,8.45 47.45))',
           world_srid()))
FROM ids;

-- submit -----------------------------------------------------------------
CREATE TEMP TABLE sent AS
SELECT submit_area('00000000-0000-0000-0000-0000000000c8', 'the wood by the road')
       AS out;
SELECT cmp_ok(((SELECT out FROM sent) ->> 'tiles')::int, '>', 0,
    'submitting covers the tiles that changed');
SELECT ok(((SELECT out FROM sent) ->> 'yours_to_approve')::boolean,
    'and says the owner is their own approver');

SELECT is((SELECT count(*)::int FROM job), 0,
    'nothing is queued yet: nobody has said yes');
SELECT is((SELECT tile_state(t) FROM tile t
           WHERE t.z = 14 AND st_intersects(
               st_geomfromtext('POINT(8.45 47.45)', world_srid()),
               tile_bbox(t.z, t.x, t.y))),
    'awaiting approval', 'and the tile says what it is waiting for');

-- who may say yes ----------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', stranger_id, 'role', 'player')::text, true) FROM ids;
SELECT is(jsonb_array_length(submissions_waiting()), 0,
    'a passer-by has nothing waiting for them');
SELECT throws_ok(format($$SELECT approve_submission(%L)$$,
    ((SELECT out FROM sent) ->> 'id')::uuid),
    '42501', 'that is not your ground to approve',
    'and cannot approve somebody else''s land');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT is(jsonb_array_length(submissions_waiting()), 1,
    'the owner has one waiting');
SELECT is(submissions_waiting() -> 0 ->> 'land', 'unnamed land',
    'named as the land it is');

-- a refusal needs a reason -------------------------------------------------
SELECT throws_like(format($$SELECT refuse_submission(%L, 'no')$$,
    ((SELECT out FROM sent) ->> 'id')::uuid),
    '%say why%', 'a refusal without a reason is refused');

-- approve ------------------------------------------------------------------
SELECT cmp_ok((approve_submission(((SELECT out FROM sent) ->> 'id')::uuid)
               ->> 'queued')::int, '>', 0, 'approving queues the tiles');
SELECT cmp_ok((SELECT count(*)::int FROM job WHERE state = 'open'), '>', 0,
    'and that is when the render jobs open');
SELECT is((SELECT tile_state(t) FROM tile t
           WHERE t.z = 14 AND st_intersects(
               st_geomfromtext('POINT(8.45 47.45)', world_srid()),
               tile_bbox(t.z, t.x, t.y))),
    'queued', 'the tile says it is queued');
SELECT throws_like(format($$SELECT approve_submission(%L)$$,
    ((SELECT out FROM sent) ->> 'id')::uuid),
    '%already approved%', 'and it cannot be approved twice');

-- refuse, on a second submission -------------------------------------------
INSERT INTO feature (area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000c8', 'water',
       st_force3d(st_geomfromtext(
           'POLYGON((8.55 47.55,8.56 47.55,8.56 47.56,8.55 47.56,8.55 47.55))',
           world_srid()))
FROM ids;
CREATE TEMP TABLE again AS
SELECT submit_area('00000000-0000-0000-0000-0000000000c8', 'and the pond') AS out;
SELECT is(refuse_submission(((SELECT out FROM again) ->> 'id')::uuid,
    'the pond is inside the road') ->> 'note', 'the pond is inside the road',
    'a refusal carries its reason');
SELECT is(area_refusal('00000000-0000-0000-0000-0000000000c8') ->> 'note',
    'the pond is inside the road',
    'and the land says so afterwards');
SELECT is((SELECT tile_state(t) FROM tile t
           WHERE t.z = 14 AND st_intersects(
               st_geomfromtext('POINT(8.55 47.55)', world_srid()),
               tile_bbox(t.z, t.x, t.y))),
    'refused', 'the tile says it was refused');

SELECT * FROM finish();
ROLLBACK;
