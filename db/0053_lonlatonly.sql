-- 0053_lonlatonly.sql — a 4326 column holds longitude and latitude, or nothing.
--
-- `feature.geom` is geometry(...,4326) and every writer put what it was given
-- straight into it. A cast to 4326 asserts an SRID, it does not convert, so a
-- geometry carrying Mercator metres — 877852.75, not 7.88 — is stored happily
-- and is wrong from then on. GeoServer publishes these layers FORCE_DECLARED,
-- so it reprojects every row it serves, and one such row makes the whole layer
-- unopenable:
--
--     PointOutsideEnvelopeException: 877852.7539891229 outside of (-90.0,90.0)
--
-- Two halves. Writes are normalised: an unset SRID is lon/lat by declaration,
-- any other SRID is transformed, and coordinates that are still not lon/lat
-- after that are refused with a sentence rather than stored. And the rows that
-- are already wrong are repaired — coordinates that large are Web Mercator,
-- which is the only projection this system ever puts a feature through, so
-- they are transformed back to where they were meant to be.
--
-- Invariant 6 is untouched: this is a BEFORE trigger on the table, so it holds
-- for QGIS, for the importer and for anything else that ever writes a feature.

CREATE FUNCTION as_lonlat(g geometry) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    out geometry := g;
BEGIN
    IF g IS null THEN
        RETURN null;
    END IF;
    IF st_srid(g) = 0 THEN
        out := st_setsrid(g, 4326);
    ELSIF st_srid(g) <> 4326 THEN
        out := st_transform(g, 4326);
    END IF;
    IF st_xmin(out) < -180 OR st_xmax(out) > 180
       OR st_ymin(out) < -90 OR st_ymax(out) > 90 THEN
        RAISE EXCEPTION
            'this geometry is not longitude and latitude: x %..%, y %..%',
            round(st_xmin(out)::numeric, 2), round(st_xmax(out)::numeric, 2),
            round(st_ymin(out)::numeric, 2), round(st_ymax(out)::numeric, 2)
            USING errcode = '22023',
                  hint = 'Draw in EPSG:4326, or send the geometry with the SRID'
                         ' it is actually in so it can be converted.';
    END IF;
    RETURN out;
END
$$;

CREATE OR REPLACE FUNCTION feature_force_3d() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.geom := st_force3d(as_lonlat(new.geom));
    RETURN new;
END;
$$;

-- The rows already stored wrong. Anything outside lon/lat range in a 4326
-- column got there as Mercator metres; putting them back is what makes the
-- layer openable again.
UPDATE feature
SET geom = st_force3d(st_transform(st_setsrid(st_force2d(geom), 3857), 4326))
WHERE geom IS NOT null
  AND (st_xmin(geom) < -180 OR st_xmax(geom) > 180
       OR st_ymin(geom) < -90 OR st_ymax(geom) > 90);

UPDATE area
SET geom = st_transform(st_setsrid(geom, 3857), 4326)
WHERE geom IS NOT null
  AND (st_xmin(geom) < -180 OR st_xmax(geom) > 180
       OR st_ymin(geom) < -90 OR st_ymax(geom) > 90);
