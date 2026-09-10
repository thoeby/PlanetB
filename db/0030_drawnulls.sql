-- 0030_drawnulls.sql — an empty field in QGIS means "the default", not NULL.
--
-- QGIS sends every column of a feature, and a field left blank arrives as an
-- explicit NULL. To Postgres that is a value, so the column default never
-- applies and the NOT NULL constraint refuses the row: "Insert error: Error
-- inserting features", the database's reason swallowed on the way. These
-- triggers fill a blank with what the default would have been. Only the admin
-- path (0008, Invariant 9) draws this way; PostgREST writes supply their own
-- values and go through row-level security as before (Invariant 6).
--
-- Named with a leading 0 so they sort before feature_3d, feature_area_default
-- and feature_bump_rev: same-timing triggers fire in name order, and those
-- read what these fill in.

CREATE FUNCTION area_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.owner_id := coalesce(new.owner_id, gis.default_owner());
    new.detail := coalesce(new.detail, 14);
    new.rules := coalesce(new.rules, '{"required_approvals": 1}'::jsonb);
    new.created_at := coalesce(new.created_at, now());
    IF new.owner_id IS NULL THEN
        RAISE EXCEPTION 'no account to own this yet — create one in Setup first';
    END IF;
    RETURN new;
END;
$$;

CREATE TRIGGER area_0_defaults BEFORE INSERT ON area
FOR EACH ROW EXECUTE FUNCTION area_defaults();

CREATE FUNCTION feature_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.props := coalesce(new.props, '{}'::jsonb);
    new.rev := coalesce(new.rev, 1);
    IF new.kind IS NULL THEN
        RAISE EXCEPTION 'kind is empty — one of road, forest, water, footprint, terrainmod';
    END IF;
    RETURN new;
END;
$$;

CREATE TRIGGER feature_0_defaults BEFORE INSERT ON feature
FOR EACH ROW EXECUTE FUNCTION feature_defaults();

CREATE FUNCTION instance_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.h := coalesce(new.h, 0);
    new.yaw := coalesce(new.yaw, 0);
    new.pitch := coalesce(new.pitch, 0);
    new.roll := coalesce(new.roll, 0);
    new.scale := coalesce(new.scale, 1);
    new.props := coalesce(new.props, '{}'::jsonb);
    new.rev := coalesce(new.rev, 1);
    RETURN new;
END;
$$;

CREATE TRIGGER instance_0_defaults BEFORE INSERT ON instance
FOR EACH ROW EXECUTE FUNCTION instance_defaults();
