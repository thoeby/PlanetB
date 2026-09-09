-- 0020_assets.sql — the catalog's write path (WP4.1).
--
-- A SAN is not chosen: it is `S` + base32 of the first 60 bits of the canonical
-- GLB's sha256 (ARCHITECTURE §1), derived here so a client cannot name its own
-- asset. Uploading is still the client's job — canon-v1 runs in the tab, the
-- bytes go to nginx, register_artifact records them — and this only turns an
-- artifact that already exists into a catalog entry.
--
-- Invariant 1: two uploads of the same model produce the same bytes, the same
-- sha256 and therefore the same SAN, so registering twice is a no-op rather
-- than a second asset.

-- A thumbnail is rendered client-side and stored as /assets/{sha}.webp
-- (ARCHITECTURE §7). Nothing pointed at it; this is the pointer. Nullable,
-- because an asset is usable before anyone has drawn its picture.
ALTER TABLE asset ADD COLUMN thumb_sha256 text REFERENCES artifact (sha256);

CREATE OR REPLACE VIEW api.asset WITH (security_invoker = true) AS
SELECT * FROM public.asset;

CREATE FUNCTION derive_san(sha256 text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    b   bytea;
    out text := 'S';
    bit int;
BEGIN
    IF derive_san.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'not a sha256: %', derive_san.sha256 USING errcode = 'PT400';
    END IF;
    b := decode(substr(derive_san.sha256, 1, 16), 'hex');
    FOR i IN 0 .. 11 LOOP
        bit := i * 5;
        out := out || substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
            ((get_byte(b, bit / 8) * 256 + get_byte(b, bit / 8 + 1))
                >> (11 - (bit % 8))) % 32 + 1, 1);
    END LOOP;
    RETURN out;
END
$$;

-- meta carries what canon-v1 measured: name, category, bbox, tris, tex_bytes,
-- the licence and its price, and the thumbnail's sha256 if one was rendered.
CREATE FUNCTION register_asset(sha256 text, canon_version smallint, meta jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid     uuid := current_user_id();
    p_sha   text := register_asset.sha256;
    new_san text := derive_san(register_asset.sha256);
    lic     text := coalesce(meta ->> 'license', 'cc0');
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = p_sha AND a.kind = 'glb') THEN
        RAISE EXCEPTION 'no glb artifact %', p_sha USING errcode = 'PT404';
    END IF;
    IF meta ->> 'thumb_sha256' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = meta ->> 'thumb_sha256') THEN
        RAISE EXCEPTION 'no thumb artifact %', meta ->> 'thumb_sha256' USING errcode = 'PT404';
    END IF;

    INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                       tex_bytes, license, price, editions, creator_id, thumb_sha256)
    VALUES (new_san, p_sha, register_asset.canon_version,
            coalesce(meta ->> 'name', new_san), coalesce(meta ->> 'category', 'prop'),
            coalesce(meta -> 'bbox', '{}'::jsonb),
            coalesce((meta ->> 'tris')::int, 0), coalesce((meta ->> 'tex_bytes')::int, 0),
            lic, coalesce((meta ->> 'price')::numeric, 0),
            CASE WHEN lic = 'limited' THEN (meta ->> 'editions')::int END,
            uid, meta ->> 'thumb_sha256')
    ON CONFLICT (san) DO NOTHING;
    RETURN new_san;
END
$$;

-- ------------------------------------------------------- near-duplicate check

-- A canon bbox as one flat array, min then max, so two of them can be compared
-- component by component.
CREATE FUNCTION box_vals(b jsonb) RETURNS double precision []
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN b ? 'min' AND b ? 'max' THEN
    ARRAY(SELECT jsonb_array_elements_text(b -> 'min')::double precision)
    || ARRAY(SELECT jsonb_array_elements_text(b -> 'max')::double precision)
END;
$$;

CREATE FUNCTION box_close(a jsonb, b jsonb, tolerance double precision)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT cardinality(box_vals(a)) = 6 AND cardinality(box_vals(b)) = 6
   AND coalesce(bool_and(
       abs(x - y) <= greatest(0.01, tolerance * greatest(abs(x), abs(y)))), false)
FROM unnest(box_vals(a), box_vals(b)) AS t (x, y);
$$;

-- What catalog.html asks before an upload: same name, or the same shape and
-- roughly the same triangle count. It answers with assets, not a verdict —
-- what to do about a near-duplicate is the uploader's call.
CREATE FUNCTION similar_assets(name text, tris int, bbox jsonb,
                               tolerance double precision DEFAULT 0.05)
RETURNS SETOF asset
LANGUAGE sql STABLE AS $$
SELECT a.* FROM asset a
WHERE lower(a.name) = lower(similar_assets.name)
   OR (abs(a.tris - similar_assets.tris)
           <= greatest(2, similar_assets.tris * similar_assets.tolerance)
       AND box_close(a.bbox, similar_assets.bbox, similar_assets.tolerance))
ORDER BY a.san
LIMIT 20;
$$;

GRANT EXECUTE ON FUNCTION derive_san(text), box_vals(jsonb),
    box_close(jsonb, jsonb, double precision),
    similar_assets(text, int, jsonb, double precision) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION register_asset(text, smallint, jsonb) TO player, admin;

CREATE FUNCTION api.register_asset(sha256 text, canon_version smallint, meta jsonb)
RETURNS text LANGUAGE sql
AS $$SELECT public.register_asset(sha256, canon_version, meta)$$;
GRANT EXECUTE ON FUNCTION api.register_asset(text, smallint, jsonb) TO player, admin;

CREATE FUNCTION api.similar_assets(name text, tris int, bbox jsonb,
                                   tolerance double precision DEFAULT 0.05)
RETURNS SETOF public.asset LANGUAGE sql STABLE
AS $$SELECT * FROM public.similar_assets(name, tris, bbox, tolerance)$$;
GRANT EXECUTE ON FUNCTION api.similar_assets(text, int, jsonb, double precision)
TO anon, player, admin;
