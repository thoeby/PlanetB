-- 0139_rulesaresymbols.sql — a rule becomes a symbol, and a symbol is layers.
--
-- TASKS-foundation.md FND.7, PLAN-foundation.md §3. A rule produced a bag of
-- values the compiler knew how to read: `width` meant a road, `sides` meant a
-- tree. Which is to say the compiler still knew what a road was, and a world
-- could only ever build the handful of things it had been taught.
--
-- A symbol produces a stack of **layers** instead — a surface along a line,
-- pieces repeated along it, models scattered over an area, an outline
-- extruded, a model placed, a material painted, a check run. Each layer's
-- parameters may still be read off the feature ({"prop": "width", "else": 5}),
-- because that part of a rule was right.
--
-- Every rule in this world becomes a symbol with the one layer that
-- reproduces it exactly: client/test/assemble.test.js compiles the same
-- fixture world both ways and compares the bytes, and `build_rule` is dropped
-- at the end of this file only because that test is green.
--
-- Invariant 2: a tile's snapshot pinned the rules' digest; it pins the applied
-- style version now, so an atom built before a symbol changed can still tell
-- that the world moved under it.

-- --------------------------------------------------------------- the symbol

CREATE TABLE symbol (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN (
        '*', 'highway', 'railway', 'aerialway', 'barrier', 'waterway',
        'building', 'landuse', 'natural', 'natural_point', 'terrainmod')),
    ordering   int NOT NULL DEFAULT 100,
    filter     jsonb NOT NULL DEFAULT '[]'::jsonb,
    layers     jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled    boolean NOT NULL DEFAULT true,
    version    int NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX symbol_kind_idx ON symbol (kind, ordering, id);

-- Every version a symbol has ever been saved as, so an old one can be looked
-- at and made the current one again.
CREATE TABLE symbol_version (
    symbol_id uuid NOT NULL REFERENCES symbol (id) ON DELETE CASCADE,
    version   int NOT NULL,
    name      text NOT NULL,
    filter    jsonb NOT NULL,
    layers    jsonb NOT NULL,
    saved_by  uuid REFERENCES auth.user (id),
    saved_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol_id, version)
);

-- What the world is actually built with: a version of every enabled symbol,
-- fixed at the moment somebody applied them. Saving a symbol changes nothing
-- anybody can see until then (FND.8).
CREATE TABLE style_version (
    id            serial PRIMARY KEY,
    symbols       jsonb NOT NULL,
    cover_mapping int NOT NULL DEFAULT 1,
    note          text,
    applied_by    uuid REFERENCES auth.user (id),
    applied_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE symbol ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON symbol FOR SELECT USING (true);
CREATE POLICY read_all ON symbol_version FOR SELECT USING (true);
CREATE POLICY read_all ON style_version FOR SELECT USING (true);
CREATE POLICY admin_writes ON symbol FOR ALL TO admin USING (true) WITH CHECK (true);
CREATE POLICY admin_writes ON symbol_version FOR ALL TO admin USING (true) WITH CHECK (true);
CREATE POLICY admin_writes ON style_version FOR ALL TO admin USING (true) WITH CHECK (true);
GRANT SELECT ON symbol, symbol_version, style_version TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON symbol, symbol_version, style_version TO admin;
GRANT USAGE, SELECT ON SEQUENCE style_version_id_seq TO admin;

CREATE VIEW api.symbol WITH (security_invoker = true) AS SELECT * FROM public.symbol;
CREATE VIEW api.symbol_version WITH (security_invoker = true)
AS SELECT * FROM public.symbol_version;
CREATE VIEW api.style_version WITH (security_invoker = true)
AS SELECT * FROM public.style_version;
GRANT SELECT ON api.symbol, api.symbol_version, api.style_version TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.symbol TO admin;

-- --------------------------------------------------------- rules become them

-- The one layer that reproduces a rule. Which layer it is is read off what the
-- rule produced, because that is all a rule ever said about itself: a `width`
-- is a surface along a line, `sides` and `taper` are a stand of trees, a roof
-- is an extruded outline, an `op` is the old shaping operation.
CREATE FUNCTION layer_of_rule(p_kind text, p_style jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
    WHEN p_style ? 'op' OR p_kind = 'terrainmod' THEN jsonb_build_array(jsonb_build_object(
        'layer', 'terrainmod', 'params', jsonb_strip_nulls(jsonb_build_object(
            'op', p_style -> 'op', 'amount', p_style -> 'amount'))))
    WHEN p_style ? 'sides' OR p_style ? 'taper' THEN jsonb_build_array(jsonb_build_object(
        'layer', 'scatter', 'params', jsonb_strip_nulls(jsonb_build_object(
            'height', p_style -> 'height', 'sides', p_style -> 'sides',
            'taper', p_style -> 'taper', 'colour', p_style -> 'color',
            'mature', p_style -> 'mature', 'age_prop', p_style -> 'age_prop'))))
    WHEN p_style ? 'roof' OR p_kind = 'building' THEN jsonb_build_array(jsonb_build_object(
        'layer', 'extrude', 'params', jsonb_strip_nulls(jsonb_build_object(
            'height', p_style -> 'height', 'roof', p_style -> 'roof',
            'roof_colour', p_style -> 'roof_color'))))
    WHEN p_style ? 'width' THEN jsonb_build_array(jsonb_build_object(
        'layer', 'surface', 'params', jsonb_strip_nulls(jsonb_build_object(
            'width', p_style -> 'width'))))
    ELSE '[]'::jsonb
END;
$$;

INSERT INTO symbol (name, kind, ordering, filter, layers, enabled)
SELECT r.name, r.kind, r.ordering, r.filter, layer_of_rule(r.kind, r.style), r.enabled
FROM build_rule r
WHERE NOT EXISTS (SELECT 1 FROM symbol);

-- Water was never a rule: `assemble` laid a sheet over every `natural=water`
-- because it was written into the compiler. It is a symbol like anything else
-- now, and this is that symbol.
INSERT INTO symbol (name, kind, ordering, filter, layers)
SELECT 'water', 'natural', 990,
    '[{"op": "in", "prop": "natural", "value": ["water"]}]'::jsonb,
    '[{"layer": "surface", "params": {}}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM symbol WHERE name = 'water' AND kind = 'natural');

INSERT INTO symbol_version (symbol_id, version, name, filter, layers)
SELECT s.id, s.version, s.name, s.filter, s.layers FROM symbol s
WHERE NOT EXISTS (SELECT 1 FROM symbol_version v WHERE v.symbol_id = s.id);

-- The first applied style: every symbol as it is right now, which is every
-- rule as it was. Nothing anybody has published changes.
INSERT INTO style_version (symbols, note)
SELECT coalesce(jsonb_object_agg(s.id::text, s.version), '{}'::jsonb),
    'the rules, as they were'
FROM symbol s WHERE s.enabled AND NOT EXISTS (SELECT 1 FROM style_version);

-- ------------------------------------------------------------- what is built

-- The symbols the world is built with: the version of each that the latest
-- applied style pinned, not whatever has been saved since (Invariant 2).
CREATE FUNCTION pinned_symbols() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', v.name, 'kind', s.kind, 'ordering', s.ordering,
    'enabled', s.enabled, 'version', v.version,
    'filter', v.filter, 'layers', v.layers)
    ORDER BY s.kind, s.ordering, s.id), '[]'::jsonb)
FROM style_version p
CROSS JOIN LATERAL jsonb_each_text(p.symbols) AS pin (sid, ver)
JOIN symbol s ON s.id = pin.sid::uuid
JOIN symbol_version v ON v.symbol_id = s.id AND v.version = pin.ver::int
WHERE p.id = (SELECT max(id) FROM style_version) AND s.enabled;
$$;

-- The catalogue numbers the pinned symbols name, and the file behind each:
-- a segment's GLB, a profile's or a collection's JSON, a material's PNG. The
-- atom fetches them the way it fetches an instance's GLB.
CREATE FUNCTION symbol_files() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_object_agg(a.san,
    jsonb_build_object('sha256', a.sha256, 'type', a.type)), '{}'::jsonb)
FROM asset a
WHERE a.san IN (
    SELECT p #>> '{}'
    FROM jsonb_array_elements(pinned_symbols()) s,
        LATERAL jsonb_path_query(s -> 'layers',
            '$[*].params.segment') p
    UNION
    SELECT p #>> '{}'
    FROM jsonb_array_elements(pinned_symbols()) s,
        LATERAL jsonb_path_query(s -> 'layers', '$[*].params.model') p
    UNION
    SELECT p #>> '{}'
    FROM jsonb_array_elements(pinned_symbols()) s,
        LATERAL jsonb_path_query(s -> 'layers', '$[*].params.material') p
    UNION
    SELECT p #>> '{}'
    FROM jsonb_array_elements(pinned_symbols()) s,
        LATERAL jsonb_path_query(s -> 'layers', '$[*].params.collection') p
    UNION
    SELECT p #>> '{}'
    FROM jsonb_array_elements(pinned_symbols()) s,
        LATERAL jsonb_path_query(s -> 'layers', '$[*].params.profile') p);
$$;

GRANT EXECUTE ON FUNCTION layer_of_rule(text, jsonb), pinned_symbols(), symbol_files()
    TO anon, player, admin;

-- ------------------------------------------------------- what a layer needs

-- A layer that names a product names one of the right kind: a repeating piece
-- repeats, a cross-section is a cross-section. The page says the same thing
-- before it saves (client/lib/symbols.js); this is the one that decides
-- (Invariant 6).
CREATE FUNCTION check_layers(p_layers jsonb) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
    l     jsonb;
    f     record;
    which text;
    got   text;
BEGIN
    FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p_layers, '[]'::jsonb)) LOOP
        IF (l ->> 'layer') NOT IN ('surface', 'repeat', 'scatter', 'extrude',
                                   'place', 'paint', 'check', 'terrainmod') THEN
            RAISE EXCEPTION 'there is no layer called %', l ->> 'layer';
        END IF;
        FOR f IN SELECT * FROM (VALUES
            ('profile', 'profile', 'road cross-section'),
            ('segment', 'segment', 'repeating piece'),
            ('model', 'model', 'model'),
            ('collection', 'collection', 'collection'),
            ('material', 'material', 'surface material')) AS v (field, want, words)
        LOOP
            which := l #>> ARRAY['params', f.field];
            CONTINUE WHEN which IS NULL;
            SELECT a.type INTO got FROM asset a WHERE a.san = which;
            IF got IS NOT NULL AND got <> f.want THEN
                RAISE EXCEPTION '% needs a %, and % is a %',
                    l ->> 'layer', f.words, which, got;
            END IF;
        END LOOP;
    END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION check_layers(jsonb) TO anon, player, admin;

-- -------------------------------------------------------------- saving one

-- Admin only (Invariant 6). A save is a new version, never an overwrite: the
-- one before it stays readable, and nothing the world has published changes
-- until somebody applies the styles (FND.8).
CREATE FUNCTION save_symbol(p_id uuid, p_name text, p_kind text, p_ordering int,
                            p_filter jsonb, p_layers jsonb, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    sid uuid := p_id;
    ver int;
BEGIN
    -- Invariant 6: what the world builds is the operator's, and the database
    -- is where that is decided.
    PERFORM require_admin();
    PERFORM check_layers(p_layers);
    IF sid IS NULL THEN
        INSERT INTO symbol (name, kind, ordering, filter, layers, enabled)
        VALUES (p_name, p_kind, coalesce(p_ordering, 100), coalesce(p_filter, '[]'::jsonb),
                coalesce(p_layers, '[]'::jsonb), coalesce(p_enabled, true))
        RETURNING id, version INTO sid, ver;
    ELSE
        UPDATE symbol SET name = p_name, kind = p_kind,
            ordering = coalesce(p_ordering, ordering),
            filter = coalesce(p_filter, filter), layers = coalesce(p_layers, layers),
            enabled = coalesce(p_enabled, enabled),
            version = version + 1, updated_at = now()
        WHERE id = sid RETURNING version INTO ver;
        IF ver IS NULL THEN
            RAISE EXCEPTION 'no symbol %', sid USING errcode = 'PT404';
        END IF;
    END IF;
    INSERT INTO symbol_version (symbol_id, version, name, filter, layers, saved_by)
    VALUES (sid, ver, p_name, coalesce(p_filter, '[]'::jsonb),
            coalesce(p_layers, '[]'::jsonb), uid)
    ON CONFLICT (symbol_id, version) DO NOTHING;
    RETURN jsonb_build_object('id', sid, 'version', ver);
END
$$;
GRANT EXECUTE ON FUNCTION save_symbol(uuid, text, text, int, jsonb, jsonb, boolean)
    TO admin;

CREATE FUNCTION api.save_symbol(p_id uuid, p_name text, p_kind text, p_ordering int,
                                p_filter jsonb, p_layers jsonb, p_enabled boolean)
RETURNS jsonb LANGUAGE sql
AS $$SELECT public.save_symbol(p_id, p_name, p_kind, p_ordering, p_filter,
                               p_layers, p_enabled)$$;
GRANT EXECUTE ON FUNCTION api.save_symbol(uuid, text, text, int, jsonb, jsonb, boolean)
    TO admin;

CREATE FUNCTION api.pinned_symbols() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.pinned_symbols()$$;
GRANT EXECUTE ON FUNCTION api.pinned_symbols() TO anon, player, admin;

-- ---------------------------------------------------------------- the world

-- db/0036's world_snapshot, pinning the applied style instead of the rules'
-- digest (Invariant 2). A symbol saved but not applied does not move it,
-- which is exactly what "not in the world yet" means.
CREATE OR REPLACE FUNCTION world_snapshot(z int, x int, y int) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
SELECT encode(public.digest(
    coalesce(string_agg(sig, ',' ORDER BY sig), '') || E'\nstyle:'
    || coalesce((SELECT max(id) FROM style_version), 0)::text,
    'sha256'), 'hex')
FROM (
    SELECT f.id::text || ':' || f.rev::text AS sig
    FROM feature f
    WHERE f.deleted_at IS NULL
      AND st_intersects(f.geom, tile_bbox(z, x, y))
    UNION ALL
    SELECT i.id::text || ':' || i.rev::text
    FROM instance i
    WHERE i.deleted_at IS NULL
      AND st_intersects(i.geom, tile_bbox(z, x, y))
) s;
$$;

-- db/0138's tile_world, with the pinned symbols where the rules were and the
-- files those symbols name beside them.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'symbols', pinned_symbols(),
    'symbol_files', symbol_files(),
    'features', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'kind', f.kind, 'rev', f.rev, 'props', f.props,
            'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id)
        FROM feature f
        WHERE f.deleted_at IS NULL
          AND st_intersects(f.geom, tile_bbox(z, x, y))), '[]'::jsonb),
    'instances', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'san', i.san, 'rev', i.rev, 'props', i.props,
            'sha256', a.sha256, 'canon_version', a.canon_version, 'parts', a.parts,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

-- db/0138's build_dag, with assemble at `assemble-v6`.
--
-- Invariant 2: the atom reads symbols now, and a worker running the old code
-- against this world would find no rules at all and build bare ground.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v2' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    chunk  int := frame_chunk();
    i      int;
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v6', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v10',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v7',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                'seed_share', 0.0375,
                'scale', 3,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

-- ------------------------------------------------------ the rules are gone

-- db/0078's project goes out of date when the vocabulary changes; a symbol is
-- half of that vocabulary now.
CREATE TRIGGER symbol_vocabulary AFTER INSERT OR UPDATE OR DELETE ON symbol
FOR EACH STATEMENT EXECUTE FUNCTION bump_vocabulary();

DROP TRIGGER build_rule_vocabulary ON build_rule;
DROP VIEW api.build_rule;
DROP FUNCTION rules_digest();
DROP TABLE build_rule;
