BEGIN;
SELECT plan(2);

SELECT is(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'gis' AND table_name = 'area'),
    ARRAY['id', 'geom', 'detail'],
    'gis.area shows only what a drawer touches'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- What GeoServer sends for a Save with detail left blank: 0, and no id.
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);
SELECT is((SELECT detail FROM area), 14::smallint, 'drawn through the view, defaulted by the table');

-- Drawing a feature is db/test/0034_giskinds.sql's: there is no gis.feature and
-- no fixed set of layers any more — one is generated per kind the world has
-- (db/0041_gisforms.sql), and that is where the 2D-to-3D check lives.

SELECT * FROM finish();
ROLLBACK;
