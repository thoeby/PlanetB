-- 0028_gisdefaults.sql — nothing typed into QGIS that the world already knows.
--
-- Drawing an area meant filling in owner_id, a uuid nobody can remember, and
-- detail, a number only this project cares about. Both are answerable without
-- asking: the operator drawing through GeoServer is the admin, and the baseline
-- zoom is 14. Same trick db/0008_admin.sql already plays with `kind` on the
-- feature views.
--
-- These are defaults on views used only by the GeoServer admin path
-- (Invariant 9). Nothing about the browser API changes: PostgREST writes still
-- carry their own owner and go through row-level security (Invariant 6).

-- The account the operator draws as. There is exactly one admin in an ordinary
-- single-operator install; where there are several, the oldest is the one that
-- set the world up.
CREATE FUNCTION gis.default_owner() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT id FROM auth.user WHERE role = 'admin' ORDER BY created_at LIMIT 1;
$$;

-- The area a geometry falls inside, so a feature drawn in the right place needs
-- no uuid typed at all. Ambiguity is resolved by the smallest area containing
-- it, which is the most specific promise about that ground.
CREATE FUNCTION gis.area_at(g geometry) RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT a.id FROM area a
    WHERE st_intersects(a.geom, st_pointonsurface(g))
    ORDER BY st_area(a.geom)
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION gis.default_owner(), gis.area_at(geometry) TO geoserver;

ALTER VIEW gis.area ALTER COLUMN owner_id SET DEFAULT gis.default_owner();
ALTER VIEW gis.area ALTER COLUMN detail SET DEFAULT 14;

-- area_id cannot be a column default: a default expression cannot see the row's
-- own geometry. A BEFORE trigger can, and fires before the NOT NULL is checked.
-- Named to sort before feature_bump_rev, which reads area_id to check that the
-- geometry is inside it — same-timing triggers fire in name order.
-- The two branches are separate statements rather than one CASE: plpgsql
-- resolves a record field when it compiles the expression, so naming new.lon in
-- an expression reached from `feature` fails even where the CASE would never
-- choose it. A branch that is never executed is never compiled.
CREATE FUNCTION default_area() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF new.area_id IS NOT NULL THEN
        RETURN new;
    END IF;
    IF tg_table_name = 'instance' THEN
        new.area_id := gis.area_at(st_setsrid(st_makepoint(new.lon, new.lat), 4326));
    ELSE
        new.area_id := gis.area_at(new.geom);
    END IF;
    IF new.area_id IS NULL THEN
        RAISE EXCEPTION 'nothing here belongs to an area yet — draw an area '
                        'first, then draw inside it';
    END IF;
    RETURN new;
END;
$$;

CREATE TRIGGER feature_area_default BEFORE INSERT ON feature
FOR EACH ROW EXECUTE FUNCTION default_area();

CREATE TRIGGER instance_area_default BEFORE INSERT ON instance
FOR EACH ROW EXECUTE FUNCTION default_area();
