-- Land an admin can take back: the ground it covered is changed, the jobs on
-- it are cancelled, what stood on it goes with it, and nobody but an admin can
-- do any of that.
BEGIN;
SELECT plan(10);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('own85@example.com', 'password12') AS owner_id,
       register('adm85@example.com', 'password12') AS admin_id,
       register('pass85@example.com', 'password12') AS stranger_id;
UPDATE auth.user SET role = 'admin' WHERE id = (SELECT admin_id FROM ids);

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000085'::uuid,
       st_geomfromtext('POLYGON((7.80 46.29,7.81 46.29,7.81 46.30,7.80 46.30,7.80 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000085', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

-- A job open on it, so the delete has something to supersede.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.805, 14), tile_y(46.295, 14)) AS jid;
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'open',
    'a job is open on the land');

-- Nobody but an admin.
SELECT throws_ok(
    $$SELECT delete_area('00000000-0000-0000-0000-000000000085'::uuid)$$,
    '42501', null, 'the owner of the land may not delete it');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', stranger_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok(
    $$SELECT delete_area('00000000-0000-0000-0000-000000000085'::uuid)$$,
    '42501', null, 'and nor may a passer-by');

-- The admin sees every piece of land there is; a player sees none of it here.
SELECT is(jsonb_array_length(all_areas()), 0,
    'all_areas tells a player nothing — it is the admin''s list');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'admin')::text, true) FROM ids;
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(all_areas()) a
                  WHERE (a ->> 'id')::uuid = '00000000-0000-0000-0000-000000000085'),
    'and it lists land that is nobody''s of the admin''s');

CREATE TEMP TABLE gone AS
SELECT delete_area('00000000-0000-0000-0000-000000000085'::uuid) AS r;

SELECT ok(((SELECT r FROM gone) ->> 'tiles')::int > 0,
    'the ground it covered is marked changed');
SELECT is(((SELECT r FROM gone) ->> 'jobs')::int, 1,
    'and the job that was building the old version is cancelled');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'cancelled',
    'which the job itself says');
SELECT is((SELECT count(*)::int FROM feature
           WHERE area_id = '00000000-0000-0000-0000-000000000085'), 0,
    'what somebody drew on it goes with it');
SELECT is((SELECT count(*)::int FROM area
           WHERE id = '00000000-0000-0000-0000-000000000085'), 0,
    'and the land itself is gone');

ROLLBACK;
