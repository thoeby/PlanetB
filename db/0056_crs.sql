-- 0056_crs.sql — the coordinate systems, defined once.
--
-- The world is stored in lon/lat: the SRID of every geometry column since
-- db/0001_schema.sql, read back off area.geom rather than typed in
-- (feature.geom carries its SRID as a CHECK constraint, db/0029, which
-- find_srid() cannot parse). Ground rasters are
-- cut per Web-Mercator ZXY tile, in the projection that grid is defined in.
-- Everything else — server/splatworld/crs.py, client/lib/crs.js, the shell
-- tests — is pinned to these two functions by a test, so an EPSG code is
-- spelled out in exactly one place per language and cannot drift.

CREATE FUNCTION world_srid() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT find_srid('public', 'area', 'geom');
$$;

-- The projection the ZXY tile grid (tile_x/tile_y/tile_bbox) is defined in.
CREATE FUNCTION tile_srid() RETURNS int
LANGUAGE sql IMMUTABLE AS $$
SELECT 3857;
$$;

-- A tile's bounds in the tile projection, by exact arithmetic on the grid
-- rather than st_transform(tile_bbox()), so a raster cut from them is
-- bit-identical run after run (Invariant 1: the cut is the artifact).
CREATE FUNCTION tile_bbox_merc(z int, x int, y int) RETURNS geometry
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT st_makeenvelope(
    -k.r + x * m.s, k.r - (y + 1) * m.s, -k.r + (x + 1) * m.s, k.r - y * m.s,
    tile_srid())
FROM (SELECT 20037508.342789244::double precision AS r) AS k,
    LATERAL (SELECT 2 * k.r / (1 << z) AS s) AS m;
$$;

GRANT EXECUTE ON FUNCTION world_srid(), tile_srid(), tile_bbox_merc(int, int, int)
TO anon, player, admin, geoserver;

-- gis.tile's geometry came out of a function and so carried no type modifier:
-- geometry_columns listed it with SRID 0 and GeoServer saw an unknown native
-- SRS. Typed, the layer declares itself like every other gis view.
DROP VIEW gis.tile;
CREATE VIEW gis.tile AS
SELECT
    t.z, t.x, t.y, t.dirty, t.expected_version, t.published_version,
    t.published_at,
    CASE
        WHEN t.published_version = 0 THEN 'unpublished'
        WHEN t.dirty THEN 'stale'
        ELSE 'current'
    END AS status,
    tile_bbox(t.z, t.x, t.y)::geometry(Polygon, 4326) AS geom
FROM tile AS t;
GRANT SELECT ON gis.tile TO geoserver;
