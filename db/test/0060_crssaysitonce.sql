-- The twelve bodies db/0060_crssaysitonce.sql rewrote still answer the same,
-- and they answer in the world's CRS because they ask for it by name.
BEGIN;
SELECT plan(6);

SELECT is(st_srid(tile_bbox(14, 8551, 5810)), world_srid(),
    'tile_bbox is in the world CRS');
SELECT is(st_srid(as_lonlat(st_makepoint(8.5, 47.5))), world_srid(),
    'a geometry with no SRID is taken to be lon/lat');
SELECT is(
    round(st_x(as_lonlat(st_transform(
        st_setsrid(st_makepoint(8.5, 47.5), world_srid()), tile_srid())))::numeric, 6),
    8.5::numeric,
    'and one in the tile CRS comes back transformed');
SELECT throws_ok(
    $$SELECT as_lonlat(st_setsrid(st_makepoint(946000, 6000000), 0))$$,
    null, null, 'metres where degrees belong are still refused');

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000000f201', 'crs@example.com', 'x', 'admin');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-00000000e201',
 st_makeenvelope(8.4, 47.4, 8.6, 47.6, world_srid()),
 '00000000-0000-0000-0000-00000000f201', 14);

SELECT is(jsonb_array_length(area_at(8.5, 47.5)), 1,
    'area_at finds the land the point is in');
SELECT is(jsonb_array_length(area_at(1.0, 1.0)), 0,
    'and none where there is none');

SELECT * FROM finish();
ROLLBACK;
