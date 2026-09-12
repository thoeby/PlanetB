-- One definition of the coordinate systems (db/0056_crs.sql): the storage SRID
-- is read off the schema, the tile grid's projection matches tile_bbox(), and
-- every gis layer GeoServer publishes carries a typed SRID.
BEGIN;
SELECT plan(9);

SELECT is(world_srid(), 4326, 'the world is stored in lon/lat');
SELECT is(st_srid(tile_bbox(10, 534, 358)), world_srid(),
    'tile_bbox() is in the world SRID');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint
           WHERE conname = 'feature_geom_4326_3d')
          LIKE '%st_srid(geom) = ' || world_srid() || '%',
    'feature.geom is checked to be in the world SRID');
SELECT is(find_srid('public', 'instance', 'geom'), world_srid(),
    'instance.geom is in the world SRID');

SELECT is(st_srid(tile_bbox_merc(10, 534, 358)), tile_srid(),
    'tile_bbox_merc() is in the tile SRID');
SELECT ok(
    st_hausdorffdistance(tile_bbox_merc(14, 8548, 5736),
        st_transform(tile_bbox(14, 8548, 5736), tile_srid())) < 0.001,
    'tile_bbox_merc() is tile_bbox() reprojected, to a millimetre');
SELECT is(st_astext(tile_bbox_merc(0, 0, 0)),
    st_astext(st_makeenvelope(-20037508.342789244, -20037508.342789244,
        20037508.342789244, 20037508.342789244, tile_srid())),
    'z0 is the whole Web-Mercator square');

SELECT is(
    (SELECT count(*)::int FROM geometry_columns
     WHERE f_table_schema = 'gis' AND srid <> world_srid()),
    0, 'every gis layer is typed with the world SRID');
SELECT is(
    (SELECT srid FROM geometry_columns
     WHERE f_table_schema = 'gis' AND f_table_name = 'tile'),
    world_srid(), 'gis.tile geom is typed, so GeoServer sees its native SRS');

SELECT * FROM finish();
ROLLBACK;
