-- What was drawn in QGIS, per kind, for the Your land panel
-- (db/0059_areadrawn.sql).
BEGIN;
SELECT plan(5);

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000000f101', 'drawn@example.com', 'x', 'admin');
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8080/geoserver', 'demo:dem',
        st_makeenvelope(6.9, 45.9, 9.2, 48.2, world_srid()),
        '00000000-0000-0000-0000-00000000f101');

-- Whoever is drawing here; land is assigned (SPEC §3.2) and what is drawn on
-- it is drawn as the player, which db/test/0046_gisgrants.sql and
-- db/test/0065_playerroles.sh show.
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', '00000000-0000-0000-0000-00000000f101',
                                    'role', 'admin')::text, true);
INSERT INTO gis.area (geom, detail) VALUES
    (st_geomfromtext('MULTIPOLYGON(((7 46, 7.2 46, 7.2 46.2, 7 46.2, 7 46)))',
                     world_srid()), 0);
INSERT INTO gis.f_water (geom) VALUES
    (st_geomfromtext('MULTIPOLYGON(((7.01 46.01, 7.02 46.01, 7.02 46.02, 7.01 46.01)))',
                     world_srid())),
    (st_geomfromtext('MULTIPOLYGON(((7.05 46.01, 7.06 46.01, 7.06 46.02, 7.05 46.01)))',
                     world_srid()));
INSERT INTO gis.f_forest (geom) VALUES
    (st_geomfromtext('MULTIPOLYGON(((7.03 46.05, 7.04 46.05, 7.04 46.06, 7.03 46.05)))',
                     world_srid()));

CREATE TEMP TABLE mine AS SELECT id FROM area ORDER BY created_at DESC LIMIT 1;

SELECT is(jsonb_array_length(area_drawn((SELECT id FROM mine))), 2,
          'one row per kind that was drawn, not one per shape');
SELECT is(
    (SELECT k ->> 'count' FROM jsonb_array_elements(area_drawn((SELECT id FROM mine))) k
     WHERE k ->> 'kind' = 'water'),
    '2', 'with how many of that kind there are');
SELECT is(
    (SELECT array_agg(k ->> 'kind' ORDER BY k ->> 'kind')
     FROM jsonb_array_elements(area_drawn((SELECT id FROM mine))) k),
    ARRAY['forest', 'water'], 'named by kind, in a settled order');
SELECT ok(
    (SELECT (k -> 'lat')::numeric BETWEEN 46 AND 46.2
     FROM jsonb_array_elements(area_drawn((SELECT id FROM mine))) k
     WHERE k ->> 'kind' = 'forest'),
    'and a point inside one of them to fly to');
SELECT is(area_drawn('00000000-0000-0000-0000-0000000000ff'), '[]'::jsonb,
          'an area with nothing drawn on it is an empty list, not null');

SELECT * FROM finish();
ROLLBACK;
