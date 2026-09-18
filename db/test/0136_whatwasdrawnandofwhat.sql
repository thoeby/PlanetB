-- What the Submit panel says was drawn, and of what (db/0136).
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE who AS
SELECT register('deb136@example.com', 'password12') AS deb;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', deb, 'role', 'player')::text, true) FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000136'::uuid,
       st_makeenvelope(7.80, 46.30, 7.82, 46.31, 4326), deb, 14
FROM who;

SELECT is(submission_changes('00000000-0000-0000-0000-000000000136') -> 'kinds',
          '{}'::jsonb, 'land nobody has drawn on holds nothing of any kind');

INSERT INTO feature (area_id, kind, props, geom) VALUES
('00000000-0000-0000-0000-000000000136', 'highway', '{"highway": "track"}',
 st_force3d(st_geomfromtext('LINESTRING(7.801 46.301, 7.805 46.305)', 4326))),
('00000000-0000-0000-0000-000000000136', 'highway', '{"highway": "path"}',
 st_force3d(st_geomfromtext('LINESTRING(7.802 46.301, 7.806 46.305)', 4326))),
('00000000-0000-0000-0000-000000000136', 'landuse', '{"landuse": "forest"}',
 st_force3d(st_geomfromtext(
     'POLYGON((7.810 46.302, 7.812 46.302, 7.812 46.304, 7.810 46.302))', 4326)));

SELECT is(submission_changes('00000000-0000-0000-0000-000000000136') -> 'kinds',
          '{"highway": 2, "landuse": 1}'::jsonb,
          'and one that has says how many of each');
SELECT is((submission_changes('00000000-0000-0000-0000-000000000136')
           ->> 'features')::int, 3,
          'which is the same rows the one number counts');

-- Deleting is soft, and what is gone is gone from both.
UPDATE feature SET deleted_at = now()
WHERE area_id = '00000000-0000-0000-0000-000000000136' AND kind = 'landuse';
SELECT is(submission_changes('00000000-0000-0000-0000-000000000136') -> 'kinds',
          '{"highway": 2}'::jsonb, 'a kind nothing is left of is not listed');

SELECT * FROM finish();
ROLLBACK;
