-- 0032_zerodetail.sql — GeoServer's blank number is 0, and 0 means the baseline.
--
-- A separate migration rather than an edit to 0030: a database that has
-- already applied 0030 never looks at it again, and on the machine that
-- found this, that is exactly what happened.

CREATE OR REPLACE FUNCTION area_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.owner_id := coalesce(new.owner_id, gis.default_owner());
    new.detail := CASE WHEN coalesce(new.detail, 0) = 0 THEN 14 ELSE new.detail END;
    new.rules := coalesce(new.rules, '{"required_approvals": 1}'::jsonb);
    new.created_at := coalesce(new.created_at, now());
    IF new.owner_id IS NULL THEN
        RAISE EXCEPTION 'no account to own this yet — create one in Setup first';
    END IF;
    RETURN new;
END;
$$;
