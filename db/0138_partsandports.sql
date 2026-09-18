-- 0138_partsandports.sql — a model can have parts, and a part can be told things.
--
-- TASKS-foundation.md FND.6. A street lamp's head lights up, a billboard's
-- screen shows something, a tunnel portal's mouth opens the ground. None of it
-- is in the GLB — no two exporters agree on how to put it there — so the maker
-- says it in the register call, and it lands in `asset.parts` (db/0137) as
--
--   {"parts": [{"name","node","role",…}],
--    "ports": [{"name","type","default","drives":{"part","what"}}],
--    "openings": [{"name","node"}]}
--
-- Invariant 1 is what makes this a migration rather than a page: the same GLB
-- with different markings is a different product, so the markings are part of
-- what names it. canon-v2 already writes different bytes when different nodes
-- are marked, but not when only a role or a port changes — so the number is
-- derived from the canonical GLB's digest *and* the canonical text of the
-- markings, and that text is written here and nowhere else. One definition
-- cannot drift from another (Invariant 6: the client does not name its asset).

-- --------------------------------------------------------------- vocabulary

-- A name is typed by a person and read by a machine. Holding it to one word of
-- plain characters is what lets the canonical text below be written without
-- escaping anything, and it is checked before the text is ever made.
CREATE FUNCTION marks_token(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$SELECT v ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'$$;

-- A number in the one shape, so "1" and "1.0" are the same product.
CREATE FUNCTION marks_num(v jsonb, fallback numeric) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT to_char(round(coalesce(
    CASE WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN NULL
         ELSE (v #>> '{}')::numeric END, fallback), 3), 'FM999999990.000');
$$;

CREATE FUNCTION has_marks(p_parts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce(jsonb_array_length(p_parts -> 'parts'), 0) > 0
    OR coalesce(jsonb_array_length(p_parts -> 'openings'), 0) > 0;
$$;

-- What a marking may say. The page says the same sentences before it uploads
-- (client/lib/marks.js); this is the one that decides (Invariant 6).
CREATE FUNCTION check_marks(p_parts jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m     jsonb;
    names text [] := '{}';
BEGIN
    IF NOT has_marks(p_parts) THEN RETURN; END IF;
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'parts', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') THEN
            RAISE EXCEPTION '"%" is not a name a part may have', m ->> 'name';
        END IF;
        IF m ->> 'name' = ANY (names) THEN
            RAISE EXCEPTION 'there are two parts called %', m ->> 'name';
        END IF;
        names := names || (m ->> 'name');
        IF (m ->> 'role') NOT IN ('light', 'screen', 'door', 'rotor') THEN
            RAISE EXCEPTION '% needs a role', m ->> 'name';
        END IF;
        IF NOT marks_token(m ->> 'node') THEN
            RAISE EXCEPTION '"%" is not a node this model can have', m ->> 'node';
        END IF;
    END LOOP;
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'openings', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') OR NOT marks_token(m ->> 'node') THEN
            RAISE EXCEPTION '"%" is not a name an opening may have', m ->> 'name';
        END IF;
    END LOOP;
    PERFORM check_ports(p_parts, names);
END
$$;

CREATE FUNCTION check_ports(p_parts jsonb, p_names text []) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m    jsonb;
    seen text [] := '{}';
BEGIN
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'ports', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') THEN
            RAISE EXCEPTION '"%" is not a name a port may have', m ->> 'name';
        END IF;
        IF m ->> 'name' = ANY (seen) THEN
            RAISE EXCEPTION 'there are two ports called %', m ->> 'name';
        END IF;
        seen := seen || (m ->> 'name');
        IF (m ->> 'type') NOT IN ('boolean', 'number', 'text', 'image', 'colour') THEN
            RAISE EXCEPTION '% is not a kind of port', m ->> 'name';
        END IF;
        IF (m #>> '{drives,part}') IS NULL OR (m #>> '{drives,part}') <> ALL (p_names) THEN
            RAISE EXCEPTION '% drives %, which is not a part',
                m ->> 'name', coalesce(m #>> '{drives,part}', 'nothing');
        END IF;
    END LOOP;
END
$$;

-- ------------------------------------------------------------ the canonical text

-- The markings, in one order and one spelling, so the same lamp marked the
-- same way twice is one catalog entry however the two forms were filled in.
-- Everything in it is a token or a number in a fixed shape, so nothing needs
-- quoting and the text can be read back by eye.
CREATE FUNCTION marks_text(p_parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN NOT has_marks(p_parts) THEN ''
    ELSE coalesce((
        SELECT string_agg(line, '' ORDER BY line) FROM (
            SELECT 'part:' || (m ->> 'name') || ':' || (m ->> 'node') || ':'
                || (m ->> 'role') || ':' || CASE m ->> 'role'
                    WHEN 'light' THEN coalesce(m ->> 'colour', '#ffd9a0') || ':'
                        || marks_num(m -> 'intensity', 1)
                    WHEN 'screen' THEN marks_num(m -> 'aspect', 1.778)
                    ELSE coalesce(m ->> 'axis', 'y') || ':' || marks_num(m -> 'range', 90)
                END || E'\n' AS line
            FROM jsonb_array_elements(coalesce(p_parts -> 'parts', '[]')) m
            UNION ALL
            SELECT 'port:' || (m ->> 'name') || ':' || (m ->> 'type') || ':'
                || coalesce(m ->> 'default', '') || ':' || (m #>> '{drives,part}')
                || '.' || coalesce(m #>> '{drives,what}', '') || E'\n'
            FROM jsonb_array_elements(coalesce(p_parts -> 'ports', '[]')) m
            UNION ALL
            SELECT 'open:' || (m ->> 'name') || ':' || (m ->> 'node') || E'\n'
            FROM jsonb_array_elements(coalesce(p_parts -> 'openings', '[]')) m
        ) lines), '')
END;
$$;

-- What the catalogue number is derived from: the canonical GLB's digest, and
-- the markings' text when there are any. An unmarked model is unchanged, so
-- every canon-v1 product keeps the number it has always had (Invariant 1).
CREATE FUNCTION marked_sha(p_sha text, p_parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE WHEN NOT has_marks(p_parts) THEN p_sha
    ELSE encode(sha256(convert_to(p_sha || E'\n' || marks_text(p_parts), 'utf8')), 'hex')
END;
$$;

-- The number a file with these markings would get, before anything is
-- uploaded: what the Register form asks so it can say "this is already
-- <product> by <maker>". It writes nothing.
CREATE FUNCTION asset_name_for(sha256 text, parts jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE sql STABLE AS $$
SELECT derive_san(marked_sha(asset_name_for.sha256, asset_name_for.parts));
$$;

GRANT EXECUTE ON FUNCTION marks_token(text), marks_num(jsonb, numeric),
    has_marks(jsonb), check_marks(jsonb), check_ports(jsonb, text []),
    marks_text(jsonb), marked_sha(text, jsonb), asset_name_for(text, jsonb)
    TO anon, player, admin;

CREATE FUNCTION api.asset_name_for(sha256 text, parts jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE sql STABLE
AS $$SELECT public.asset_name_for(sha256, parts)$$;
GRANT EXECUTE ON FUNCTION api.asset_name_for(text, jsonb) TO anon, player, admin;

-- ------------------------------------------------------------- register_asset

-- db/0137's register_asset, with the markings in the number.
CREATE OR REPLACE FUNCTION register_asset(sha256 text, canon_version smallint,
                                          meta jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid     uuid := current_user_id();
    p_sha   text := register_asset.sha256;
    marks   jsonb := coalesce(meta -> 'parts', '{}'::jsonb);
    new_san text;
    lic     text := coalesce(meta ->> 'license', 'cc0');
    p_type  text := coalesce(meta ->> 'type', 'model');
    want    text := asset_artifact_kind(p_type);
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = p_sha AND a.kind = want) THEN
        RAISE EXCEPTION 'no % artifact %', want, p_sha USING errcode = 'PT404';
    END IF;
    IF meta ->> 'thumb_sha256' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = meta ->> 'thumb_sha256') THEN
        RAISE EXCEPTION 'no thumb artifact %', meta ->> 'thumb_sha256' USING errcode = 'PT404';
    END IF;
    PERFORM check_asset_type(p_type, meta);
    IF has_marks(marks) AND p_type NOT IN ('model', 'segment') THEN
        RAISE EXCEPTION 'only a model has parts; this is a %', p_type;
    END IF;
    PERFORM check_marks(marks);
    new_san := derive_san(marked_sha(p_sha, marks));

    INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                       tex_bytes, license, price, editions, creator_id, thumb_sha256,
                       type, parts)
    VALUES (new_san, p_sha, register_asset.canon_version,
            coalesce(meta ->> 'name', new_san), coalesce(meta ->> 'category', 'prop'),
            coalesce(meta -> 'bbox', '{}'::jsonb),
            coalesce((meta ->> 'tris')::int, 0), coalesce((meta ->> 'tex_bytes')::int, 0),
            lic, coalesce((meta ->> 'price')::numeric, 0),
            CASE WHEN lic = 'limited' THEN (meta ->> 'editions')::int END,
            uid, meta ->> 'thumb_sha256',
            p_type, marks)
    ON CONFLICT (san) DO NOTHING;
    RETURN new_san;
END
$$;

-- Two products can now stand on one file, so `asset.sha256` is no longer
-- unique by accident. Nothing ever said it was; this says it is not.
COMMENT ON COLUMN asset.sha256 IS
    'the canonical GLB; two products with different markings share one file';

-- -------------------------------------------------------------- the compiler

-- db/0036's tile_world, with each instance carrying its product's markings:
-- the compiler needs them to know which triangles it must not bake
-- (client/atoms/assemble.js leaves a screen's surface to the page).
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'rules', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', r.id, 'name', r.name, 'kind', r.kind, 'ordering', r.ordering,
            'enabled', r.enabled, 'filter', r.filter, 'style', r.style)
            ORDER BY r.kind, r.ordering, r.id)
        FROM build_rule r WHERE r.enabled), '[]'::jsonb),
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

-- db/0135's build_dag, with assemble at `assemble-v5c`.
--
-- Invariant 2: the atom leaves a screen part's surface unbaked now, so a
-- worker running the old code would bake a billboard the page then draws over.
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
        asm := new_atom(a_job, 'assemble', 'assemble-v5c', base,
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
