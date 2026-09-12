-- 0040_properties.sql — the world's vocabulary, as rows an admin edits.
--
-- TASKS-usable T3: what land, features and products may carry is defined in the
-- tool, not in code. Until now `feature.kind` was a CHECK constraint holding
-- five words taken from OSM tags, and the properties those kinds could carry
-- were `if` statements in client/lib/props.js. Neither is a thing a person can
-- change, and both are somebody else's vocabulary.
--
-- Two tables. `kind` is what a thing can be; `property` is what that kind of
-- thing can say about itself. The starter set below is modelled on OSM tags
-- because they are a good reference, not because the world is made of them —
-- every row of it can be renamed, removed or added to from the Admin panel.

CREATE TABLE kind (
    name       text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,40}$'),
    applies_to text NOT NULL DEFAULT 'feature'
                   CHECK (applies_to IN ('feature', 'product', 'area')),
    -- What a person draws for it. Null for things that are not drawn at all.
    geometry   text CHECK (geometry IN ('polygon', 'line', 'point')),
    label      text NOT NULL DEFAULT '',
    ordering   int NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kind ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON kind FOR SELECT USING (true);
GRANT SELECT ON kind TO anon, player, admin;

CREATE TABLE property (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       text NOT NULL REFERENCES kind (name) ON UPDATE CASCADE ON DELETE CASCADE,
    name       text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_:]{0,40}$'),
    label      text NOT NULL DEFAULT '',
    type       text NOT NULL DEFAULT 'text'
                   CHECK (type IN ('text', 'number', 'boolean', 'choice')),
    -- For a choice: the values a form offers and a write is held to.
    choices    text [] NOT NULL DEFAULT '{}',
    required   boolean NOT NULL DEFAULT false,
    ordering   int NOT NULL DEFAULT 100,
    UNIQUE (kind, name),
    CHECK ((type = 'choice') = (cardinality(choices) > 0))
);
CREATE INDEX property_kind_idx ON property (kind, ordering, name);
ALTER TABLE property ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON property FOR SELECT USING (true);
GRANT SELECT ON property TO anon, player, admin;

-- ------------------------------------------------------------ the old list

-- `feature.kind` was five words in a CHECK. It is a reference to the table
-- above now, so adding a kind is a row rather than a migration. The five are
-- inserted first so every feature already drawn still points at something.
INSERT INTO kind (name, applies_to, geometry, label, ordering) VALUES
('road', 'feature', 'line', 'Road', 10),
('water', 'feature', 'polygon', 'Water', 20),
('forest', 'feature', 'polygon', 'Wood', 30),
('footprint', 'feature', 'polygon', 'Building', 40),
('terrainmod', 'feature', 'polygon', 'Terrain edit', 50),
('tree', 'feature', 'point', 'Single tree', 60),
('product', 'product', null, 'Product', 100);

ALTER TABLE feature DROP CONSTRAINT feature_kind_check;
ALTER TABLE feature ADD CONSTRAINT feature_kind_fkey
    FOREIGN KEY (kind) REFERENCES kind (name) ON UPDATE CASCADE;

-- The starter set, modelled on OSM's tags: the names a surveyor would already
-- know, so a world imported from anywhere lands somewhere sensible.
INSERT INTO property (kind, name, label, type, choices, required, ordering) VALUES
('road', 'highway', 'Class', 'choice',
 ARRAY['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
       'service', 'track', 'path', 'footway'], false, 10),
('road', 'width', 'Width (m)', 'number', '{}', false, 20),
('road', 'lanes', 'Lanes', 'number', '{}', false, 30),
('road', 'surface', 'Surface', 'choice',
 ARRAY['asphalt', 'concrete', 'gravel', 'ground', 'grass'], false, 40),
('forest', 'natural', 'Cover', 'choice', ARRAY['wood', 'scrub', 'heath'], false, 10),
('forest', 'leaf_type', 'Leaves', 'choice',
 ARRAY['broadleaved', 'needleleaved', 'mixed'], false, 20),
('forest', 'species', 'Species', 'text', '{}', false, 30),
('forest', 'density', 'Trees per hectare', 'number', '{}', false, 40),
('footprint', 'building', 'Building', 'choice',
 ARRAY['house', 'residential', 'commercial', 'industrial', 'barn', 'church',
       'hut', 'ruins'], false, 10),
('footprint', 'height', 'Height (m)', 'number', '{}', false, 20),
('footprint', 'building:levels', 'Levels', 'number', '{}', false, 30),
('footprint', 'roof', 'Roof', 'choice',
 ARRAY['flat', 'gabled', 'hipped', 'pyramidal'], false, 40),
('water', 'water', 'Water', 'choice',
 ARRAY['lake', 'pond', 'river', 'stream', 'reservoir'], false, 10),
('terrainmod', 'op', 'What it does', 'choice',
 ARRAY['flatten', 'raise', 'lower', 'smooth'], true, 10),
('terrainmod', 'amount', 'Metres', 'number', '{}', false, 20),
('tree', 'species', 'Species', 'text', '{}', false, 10),
('tree', 'height', 'Height (m)', 'number', '{}', false, 20),
('tree', 'model', 'Model', 'text', '{}', false, 30),
('product', 'category', 'Category', 'text', '{}', false, 10),
('product', 'licence', 'Licence', 'choice',
 ARRAY['cc0', 'free', 'paid', 'limited'], true, 20);

-- -------------------------------------------------------------- validation

-- What a form offers and what a write is held to are the same rows. A property
-- nobody defined is still allowed through: the vocabulary is meant to grow by
-- use, and refusing an unknown key would make every import a migration.
CREATE FUNCTION check_props() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    p      record;
    value  text;
BEGIN
    FOR p IN SELECT * FROM property WHERE property.kind = new.kind LOOP
        value := new.props ->> p.name;
        IF p.required AND (value IS NULL OR value = '') THEN
            RAISE EXCEPTION '% needs %', new.kind, coalesce(nullif(p.label, ''), p.name);
        END IF;
        IF value IS NULL OR value = '' THEN
            CONTINUE;
        END IF;
        IF p.type = 'choice' AND NOT (value = ANY (p.choices)) THEN
            RAISE EXCEPTION '% must be one of %, not %',
                coalesce(nullif(p.label, ''), p.name), array_to_string(p.choices, ', '), value;
        END IF;
        IF p.type = 'number' AND value !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
            RAISE EXCEPTION '% must be a number, not %',
                coalesce(nullif(p.label, ''), p.name), value;
        END IF;
    END LOOP;
    RETURN new;
END
$$;

CREATE TRIGGER feature_props BEFORE INSERT OR UPDATE ON feature
FOR EACH ROW EXECUTE FUNCTION check_props();

-- ----------------------------------------------------------------- reading

-- Everything a form needs, in one answer: the kinds and their properties.
CREATE FUNCTION vocabulary(p_applies_to text DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_agg(k ORDER BY k ->> 'ordering', k ->> 'name'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'name', kind.name, 'label', kind.label, 'geometry', kind.geometry,
        'applies_to', kind.applies_to, 'ordering', kind.ordering,
        'properties', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'name', p.name, 'label', p.label, 'type', p.type,
                'choices', to_jsonb(p.choices), 'required', p.required,
                'ordering', p.ordering) ORDER BY p.ordering, p.name)
            FROM property p WHERE p.kind = kind.name), '[]'::jsonb)) AS k
    FROM kind
    WHERE p_applies_to IS NULL OR kind.applies_to = p_applies_to
) v;
$$;
GRANT EXECUTE ON FUNCTION vocabulary(text) TO anon, player, admin;

-- ----------------------------------------------------------------- writing

-- Only an admin, and only through these: the tables have no client grants.
CREATE FUNCTION require_admin() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin defines what the world may say'
            USING errcode = '42501';
    END IF;
END
$$;

CREATE FUNCTION put_kind(p_name text, p_applies_to text DEFAULT 'feature',
                         p_geometry text DEFAULT null, p_label text DEFAULT '',
                         p_ordering int DEFAULT 100) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM require_admin();
    INSERT INTO kind (name, applies_to, geometry, label, ordering)
    VALUES (lower(p_name), p_applies_to, p_geometry,
            coalesce(nullif(p_label, ''), initcap(replace(p_name, '_', ' '))), p_ordering)
    ON CONFLICT (name) DO UPDATE
    SET applies_to = excluded.applies_to, geometry = excluded.geometry,
        label = excluded.label, ordering = excluded.ordering;
    RETURN lower(p_name);
END
$$;

CREATE FUNCTION put_property(p_kind text, p_name text, p_type text DEFAULT 'text',
                             p_choices text [] DEFAULT '{}',
                             p_required boolean DEFAULT false,
                             p_label text DEFAULT '', p_ordering int DEFAULT 100)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    pid uuid;
BEGIN
    PERFORM require_admin();
    INSERT INTO property (kind, name, label, type, choices, required, ordering)
    VALUES (p_kind, lower(p_name),
            coalesce(nullif(p_label, ''), initcap(replace(p_name, '_', ' '))),
            p_type, coalesce(p_choices, '{}'), p_required, p_ordering)
    ON CONFLICT (kind, name) DO UPDATE
    SET label = excluded.label, type = excluded.type, choices = excluded.choices,
        required = excluded.required, ordering = excluded.ordering
    RETURNING id INTO pid;
    RETURN pid;
END
$$;

CREATE FUNCTION drop_property(p_kind text, p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    gone int;
BEGIN
    PERFORM require_admin();
    DELETE FROM property WHERE kind = p_kind AND name = lower(p_name);
    GET DIAGNOSTICS gone = ROW_COUNT;
    RETURN gone > 0;
END
$$;

GRANT EXECUTE ON FUNCTION require_admin() TO player, admin;
GRANT EXECUTE ON FUNCTION put_kind(text, text, text, text, int),
    put_property(text, text, text, text [], boolean, text, int),
    drop_property(text, text) TO player, admin;

CREATE FUNCTION api.vocabulary(applies_to text DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.vocabulary(applies_to)$$;
GRANT EXECUTE ON FUNCTION api.vocabulary(text) TO anon, player, admin;

CREATE FUNCTION api.put_kind(name text, applies_to text DEFAULT 'feature',
                             geometry text DEFAULT null, label text DEFAULT '',
                             ordering int DEFAULT 100) RETURNS text
LANGUAGE sql AS $$SELECT public.put_kind(name, applies_to, geometry, label, ordering)$$;

CREATE FUNCTION api.put_property(kind text, name text, type text DEFAULT 'text',
                                 choices text [] DEFAULT '{}',
                                 required boolean DEFAULT false,
                                 label text DEFAULT '', ordering int DEFAULT 100)
RETURNS uuid LANGUAGE sql
AS $$SELECT public.put_property(kind, name, type, choices, required, label, ordering)$$;

CREATE FUNCTION api.drop_property(kind text, name text) RETURNS boolean
LANGUAGE sql AS $$SELECT public.drop_property(kind, name)$$;

GRANT EXECUTE ON FUNCTION api.put_kind(text, text, text, text, int),
    api.put_property(text, text, text, text [], boolean, text, int),
    api.drop_property(text, text) TO player, admin;

CREATE VIEW api.kind WITH (security_invoker = true) AS SELECT * FROM public.kind;
CREATE VIEW api.property WITH (security_invoker = true) AS SELECT * FROM public.property;
GRANT SELECT ON api.kind, api.property TO anon, player, admin;
