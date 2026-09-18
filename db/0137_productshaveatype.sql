-- 0137_productshaveatype.sql — a product is not always a model.
--
-- TASKS-foundation.md FND.5, PLAN-foundation.md §3. Until now every entry in
-- the catalog was one GLB somebody places. A symbol needs four more kinds of
-- thing, and none of them is placed at all: a **segment** that repeats along a
-- line (a wall, a guard rail), a **profile** that is a road's cross-section, a
-- **collection** that is "trees like these, in these proportions", and a
-- **material** that is a surface. They are in the catalog because they are
-- made, named, licensed and paid for exactly as a model is.
--
-- Each still has a file behind it, because a SAN is derived from the sha256 of
-- what it is (Invariant 1): a model and a segment are GLBs, a material is a
-- PNG, and a profile and a collection are the JSON that describes them —
-- written once, immutable, and two identical ones are one catalog entry.

ALTER TABLE artifact DROP CONSTRAINT artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check CHECK (kind IN (
    'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply',
    'ply', 'sog', 'height', 'colliders',
    'height_edit', 'cover', 'flow', 'material', 'plugin',
    'profile', 'collection'));

ALTER TABLE asset ADD COLUMN type text NOT NULL DEFAULT 'model'
    CHECK (type IN ('model', 'segment', 'profile', 'collection', 'material'));
-- What the thing is made of, in its own shape: a profile's strips, a
-- material's tiling, and from FND.6 a model's parts and ports.
ALTER TABLE asset ADD COLUMN parts jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX asset_type_idx ON asset (type);

-- ------------------------------------------------------------- collections

-- "Mischwald: two spruces to one beech." The weights are relative, so the
-- compiler can scatter without knowing how many there will be.
CREATE TABLE collection_item (
    collection_san text NOT NULL REFERENCES asset (san) ON DELETE CASCADE,
    member_san     text NOT NULL REFERENCES asset (san),
    weight         numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
    PRIMARY KEY (collection_san, member_san)
);
CREATE INDEX collection_item_member_idx ON collection_item (member_san);

-- Invariant 6: the maker of a collection says what is in it, and nobody else.
ALTER TABLE collection_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON collection_item FOR SELECT USING (true);
CREATE POLICY mine ON collection_item FOR ALL TO player, admin
USING (EXISTS (SELECT 1 FROM asset a
               WHERE a.san = collection_item.collection_san
                 AND a.creator_id = current_user_id()))
WITH CHECK (EXISTS (SELECT 1 FROM asset a
                    WHERE a.san = collection_item.collection_san
                      AND a.creator_id = current_user_id()));
GRANT SELECT ON collection_item TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON collection_item TO player, admin;

-- A collection holds models, and a collection of collections is a question
-- nobody has asked. Said here rather than in the page (Invariant 6).
CREATE FUNCTION collection_holds_models() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    holder text;
    member text;
BEGIN
    SELECT type INTO holder FROM asset WHERE san = new.collection_san;
    SELECT type INTO member FROM asset WHERE san = new.member_san;
    IF holder <> 'collection' THEN
        RAISE EXCEPTION '% is a %, not a collection', new.collection_san, holder;
    END IF;
    IF member <> 'model' THEN
        RAISE EXCEPTION 'a collection holds models; % is a %', new.member_san, member;
    END IF;
    RETURN new;
END
$$;
CREATE TRIGGER collection_item_kinds BEFORE INSERT OR UPDATE ON collection_item
FOR EACH ROW EXECUTE FUNCTION collection_holds_models();

-- ---------------------------------------------------------- what a type needs

-- The rules the page checks before Register and the database checks again
-- (Invariant 6), in one place so the two cannot drift.
CREATE FUNCTION check_asset_type(p_type text, p_meta jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    strips jsonb := p_meta -> 'profile';
    lo     jsonb := p_meta -> 'bbox' -> 'min';
    hi     jsonb := p_meta -> 'bbox' -> 'max';
    px     int := (p_meta ->> 'px')::int;
BEGIN
    IF p_type = 'segment' THEN
        IF lo IS NULL OR hi IS NULL THEN
            RAISE EXCEPTION 'a repeating piece needs a measured model';
        END IF;
        IF (hi ->> 0)::double precision - (lo ->> 0)::double precision < 0.1 THEN
            RAISE EXCEPTION 'a repeating piece must be at least 0.10 m long';
        END IF;
    ELSIF p_type = 'profile' THEN
        IF jsonb_typeof(strips) <> 'array' OR jsonb_array_length(strips) = 0 THEN
            RAISE EXCEPTION 'a cross-section needs at least one strip';
        END IF;
    ELSIF p_type = 'material' THEN
        IF px IS NULL OR px < 1 OR px > 2048 THEN
            RAISE EXCEPTION 'a surface material is a square png of at most 2048 px';
        END IF;
        IF (px & (px - 1)) <> 0 THEN
            RAISE EXCEPTION 'a surface material is a power of two: %s is not', px;
        END IF;
        IF coalesce((p_meta ->> 'tiling')::double precision, 0) <= 0 THEN
            RAISE EXCEPTION 'a surface material needs a tiling size in metres';
        END IF;
    END IF;
END
$$;
GRANT EXECUTE ON FUNCTION check_asset_type(text, jsonb) TO anon, player, admin;

-- The file kind each type is made of.
CREATE FUNCTION asset_artifact_kind(p_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE p_type
    WHEN 'material' THEN 'material'
    WHEN 'profile' THEN 'profile'
    WHEN 'collection' THEN 'collection'
    ELSE 'glb' END;
$$;
GRANT EXECUTE ON FUNCTION asset_artifact_kind(text) TO anon, player, admin;

-- db/0020's register_asset, with the type and what each type needs.
CREATE OR REPLACE FUNCTION register_asset(sha256 text, canon_version smallint,
                                          meta jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid     uuid := current_user_id();
    p_sha   text := register_asset.sha256;
    new_san text := derive_san(register_asset.sha256);
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
            p_type, coalesce(meta -> 'parts', '{}'::jsonb))
    ON CONFLICT (san) DO NOTHING;
    RETURN new_san;
END
$$;

-- ---------------------------------------------------------------- the store

-- db/0133's can_write, with the two extensions the new types are files in:
-- a material is a .png and a profile or a collection is the .json that
-- describes it. Which type a sha may be is register_asset's question; this
-- one is only about what may be written at all.
CREATE OR REPLACE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    wid   uuid;
    m     text [];
    known boolean;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF can_write.sha256 IS NULL OR can_write.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a valid sha256 must be declared' USING errcode = 'PT403';
    END IF;
    known := EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = can_write.sha256);

    SELECT id INTO wid FROM worker WHERE user_id = uid;

    m := regexp_match(path, '^/jobs/([0-9]+)/[A-Za-z0-9._-]+$');
    IF m IS NOT NULL THEN
        IF known THEN
            RAISE EXCEPTION 'artifact already registered' USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom
                   WHERE id = m[1]::bigint AND state = 'claimed'
                     AND worker_id = wid) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'atom % is not claimed by you', m[1] USING errcode = 'PT403';
    END IF;

    m := regexp_match(path, '^/assets/([0-9a-f]{64})\.(glb|webp|elx|png|json)$');
    IF m IS NOT NULL THEN
        IF m[1] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        RETURN;
    END IF;

    m := regexp_match(path,
        '^/tiles/([0-9]+)/([0-9]+)/([0-9]+)/([0-9a-f]{64})\.(sog|r16|json)$');
    IF m IS NOT NULL THEN
        IF m[4] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom a
                   JOIN job j ON j.id = a.job_id
                   WHERE a.op = 'sog' AND a.worker_id = wid
                     AND a.state IN ('claimed', 'submitted', 'verified')
                     AND j.z = m[1]::int AND j.x = m[2]::int AND j.y = m[3]::int) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'you hold no sog atom for %/%/%', m[1], m[2], m[3]
            USING errcode = 'PT403';
    END IF;

    RAISE EXCEPTION 'path % is not writable', path USING errcode = 'PT403';
END
$$;

-- ---------------------------------------------------------------- the api

-- db/0007's api.asset was written when the table had neither column: a view
-- expands `*` once, at the moment it is created, and never again. Replacing it
-- is what gives the page the two new columns.
CREATE OR REPLACE VIEW api.asset WITH (security_invoker = true)
AS SELECT * FROM public.asset;

CREATE VIEW api.collection_item WITH (security_invoker = true)
AS SELECT * FROM public.collection_item;
GRANT SELECT ON api.collection_item TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.collection_item TO player, admin;
