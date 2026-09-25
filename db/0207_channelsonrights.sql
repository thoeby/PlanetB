-- 0207_channelsonrights.sql — a product has a current version and a legacy
-- one, and a right says which it follows.
--
-- TASKS-live.md LV.6. No version history: a SAN has one pointer per channel,
--
--   asset.pointer  {"current": sha, "legacy": sha | null}
--
-- and the files the pointers have left behind stay reachable for as long as
-- anybody pins them (Invariant 1: nothing is overwritten). A right follows a
-- channel or pins one hash, by the model the product is sold under:
--
--   once          bought once: you keep the version you bought, and receive
--                 a pointer move only when its maker flagged it a fix
--   subscription  every move while the term is paid; at `until`, with no new
--                 paid order, the right follows `legacy`
--   pinned        the one hash, whatever happens to the pointer
--
-- `asset_version` records each move — which hash, which channel, whether it
-- was a fix, and what that version needs (LV.9) — because a buy-once right
-- asks "was there a fix since I bought", and consent asks "what did that
-- version need". Nothing is rebuilt from it.

ALTER TABLE asset
ADD COLUMN pointer jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN policy text NOT NULL DEFAULT 'once'
    CHECK (policy IN ('once', 'subscription', 'pinned')),
ADD COLUMN term interval CHECK (term IS NULL OR term > interval '0'),
ADD CONSTRAINT asset_subscription_has_term CHECK ((policy = 'subscription') = (term IS NOT NULL));

UPDATE asset SET pointer = jsonb_build_object('current', sha256, 'legacy', null);

-- A product starts pointing at the file it was registered with.
CREATE FUNCTION asset_pointer_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF new.pointer IS NULL OR new.pointer = '{}'::jsonb THEN
        new.pointer := jsonb_build_object('current', new.sha256, 'legacy', null);
    END IF;
    RETURN new;
END
$$;
CREATE TRIGGER asset_pointer_default BEFORE INSERT ON asset
FOR EACH ROW EXECUTE FUNCTION asset_pointer_default();

CREATE TABLE asset_version (
    id      bigserial PRIMARY KEY,
    san     text NOT NULL REFERENCES asset (san) ON DELETE CASCADE,
    sha256  text NOT NULL REFERENCES artifact (sha256),
    channel text NOT NULL CHECK (channel IN ('current', 'legacy')),
    fix     boolean NOT NULL DEFAULT false,
    needs   jsonb NOT NULL DEFAULT '{}'::jsonb,
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_version_san_idx ON asset_version (san, id);

INSERT INTO asset_version (san, sha256, channel, at)
SELECT san, sha256, 'current', created_at FROM asset;

CREATE FUNCTION asset_first_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO asset_version (san, sha256, channel, needs)
    VALUES (new.san, new.pointer ->> 'current', 'current', '{}'::jsonb);
    RETURN new;
END
$$;
CREATE TRIGGER asset_first_version AFTER INSERT ON asset
FOR EACH ROW EXECUTE FUNCTION asset_first_version();

ALTER TABLE asset_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON asset_version FOR SELECT USING (true);
GRANT SELECT ON asset_version TO anon, player, admin;

-- ------------------------------------------------------------------ rights

ALTER TABLE asset_right
ADD COLUMN follow text NOT NULL DEFAULT 'current' CHECK (follow IN ('current', 'pinned')),
-- The hash the right was acquired at: what a buy-once right keeps and a
-- pinned one never leaves.
ADD COLUMN sha256 text REFERENCES artifact (sha256),
-- A subscription's end. Null: bought once, or pinned.
ADD COLUMN until timestamptz;

UPDATE asset_right r SET sha256 = a.sha256 FROM asset a WHERE a.san = r.san;

-- The hash a right resolves to now.
CREATE FUNCTION right_sha(p_san text, p_holder uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE
    WHEN r.san IS NULL THEN a.pointer ->> 'current'
    WHEN r.follow = 'pinned' THEN r.sha256
    WHEN r.until IS NOT NULL THEN CASE WHEN r.until > now() THEN a.pointer ->> 'current'
        ELSE coalesce(a.pointer ->> 'legacy', r.sha256) END
    ELSE coalesce((SELECT v.sha256 FROM asset_version v
                   WHERE v.san = a.san AND v.channel = 'current' AND v.fix
                     AND v.at > r.acquired_at
                   ORDER BY v.id DESC LIMIT 1), r.sha256, a.pointer ->> 'current') END
FROM asset a
LEFT JOIN asset_right r ON r.san = a.san AND r.holder_id = p_holder
WHERE a.san = p_san
$$;

GRANT EXECUTE ON FUNCTION right_sha(text, uuid) TO anon, player, admin, flow;

-- -------------------------------------------------------------- the pointer

-- Moving a channel: the maker, to a file the world already holds, of the kind
-- the product is made of. A move to where it already points changes nothing.
CREATE FUNCTION set_pointer(p_san text, p_channel text, p_sha256 text,
                            p_fix boolean DEFAULT false, p_needs jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a asset%ROWTYPE;
BEGIN
    SELECT * INTO a FROM asset WHERE san = p_san FOR UPDATE;
    IF a.san IS NULL OR a.creator_id IS DISTINCT FROM current_user_id() THEN
        RAISE EXCEPTION 'only its maker moves the pointer of %', p_san USING errcode = '42501';
    END IF;
    IF p_channel NOT IN ('current', 'legacy') THEN
        RAISE EXCEPTION 'a product has two channels, current and legacy' USING errcode = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact WHERE sha256 = p_sha256
                   AND kind = asset_artifact_kind(a.type)) THEN
        RAISE EXCEPTION 'no % artifact %', asset_artifact_kind(a.type), p_sha256
            USING errcode = 'PT404';
    END IF;
    IF a.pointer ->> p_channel IS NOT DISTINCT FROM p_sha256 THEN
        RETURN a.pointer;
    END IF;
    UPDATE asset SET pointer = pointer || jsonb_build_object(p_channel, p_sha256)
    WHERE san = p_san;
    INSERT INTO asset_version (san, sha256, channel, fix, needs)
    VALUES (p_san, p_sha256, p_channel, coalesce(p_fix, false),
            coalesce(p_needs, (SELECT v.needs FROM asset_version v WHERE v.san = p_san
                               ORDER BY v.id DESC LIMIT 1), '{}'::jsonb));
    RETURN (SELECT pointer FROM asset WHERE san = p_san);
END
$$;

GRANT EXECUTE ON FUNCTION set_pointer(text, text, text, boolean, jsonb) TO player, admin;

-- What a product is sold under, in the words the product card says before Buy.
CREATE FUNCTION policy_words(a asset) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE a.policy
    WHEN 'subscription' THEN 'Subscription: every update for as long as it is paid ('
        || a.term::text || ' at a time); after that, the last legacy version.'
    WHEN 'pinned' THEN 'This exact version, for good: updates are not passed on.'
    ELSE 'Bought once: you keep this version, and receive fixes its maker marks as fixes.'
END
$$;

GRANT EXECUTE ON FUNCTION policy_words(asset) TO anon, player, admin;

-- ----------------------------------------------------------------- orders

-- The right an order pays for, as the product is sold: bought once at the hash
-- current now, pinned to it, or subscribed to for `qty` terms more — a new
-- paid order before `until` runs on from `until`, after it from now.
CREATE FUNCTION grant_right(o store_order, a asset) RETURNS void
LANGUAGE sql SET search_path = public AS $$
INSERT INTO asset_right (san, holder_id, ref, follow, sha256, until)
VALUES (o.san, o.buyer, o.ref,
        CASE WHEN a.policy = 'pinned' THEN 'pinned' ELSE 'current' END,
        a.pointer ->> 'current',
        CASE WHEN o.term IS NOT NULL THEN now() + o.term * o.qty END)
ON CONFLICT (san, holder_id) DO UPDATE
SET until = CASE WHEN o.term IS NOT NULL
    THEN greatest(asset_right.until, now()) + o.term * o.qty ELSE asset_right.until END
$$;

-- db/0206's order_confirm, handing out the right grant_right says.
CREATE OR REPLACE FUNCTION order_confirm(p_id uuid, p_proof text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    o     store_order%ROWTYPE;
    a     asset%ROWTYPE;
    src   uuid;
    payee uuid;
    cut   numeric;
BEGIN
    SELECT * INTO o FROM store_order WHERE id = p_id FOR UPDATE;
    IF o.id IS NULL THEN
        RAISE EXCEPTION 'no such order' USING errcode = 'PT404';
    END IF;
    IF o.state = 'paid' THEN RETURN order_view(p_id); END IF;
    IF o.state = 'refunded' THEN
        RAISE EXCEPTION 'that order was refunded' USING errcode = 'PT409';
    END IF;
    -- The world's own money is confirmed by whoever pays it; a provider's by an
    -- admin, who holds the proof.
    IF (o.provider = 'internal' AND current_user_id() IS DISTINCT FROM o.buyer)
       OR (o.provider <> 'internal' AND current_user_role() IS DISTINCT FROM 'admin') THEN
        RAISE EXCEPTION 'that order is not yours to confirm' USING errcode = '42501';
    END IF;
    -- The edition lock, as buy_asset had it (db/0023): the conditional
    -- UPDATE, and only it.
    UPDATE asset SET issued = issued + 1
    WHERE san = o.san AND (editions IS NULL OR issued < editions) RETURNING * INTO a;
    IF a.san IS NULL THEN
        RAISE EXCEPTION 'asset % is sold out', o.san USING errcode = 'PT409';
    END IF;
    IF o.provider = 'internal' AND o.amount > 0 THEN
        SELECT id INTO src FROM account WHERE owner_id = o.buyer;
        SELECT id INTO payee FROM account WHERE owner_id = a.creator_id;
        IF payee IS NULL THEN
            RAISE EXCEPTION 'the creator of % has no account', o.san USING errcode = 'PT404';
        END IF;
        cut := CASE WHEN operator_account() IS NULL OR operator_account() = payee THEN 0
            ELSE round(o.amount * store_cut(), 6) END;
        PERFORM transfer(src, payee, o.amount - cut, o.ref);
        IF cut > 0 THEN
            PERFORM transfer(src, operator_account(), cut, o.ref || ':cut');
        END IF;
    END IF;
    PERFORM grant_right(o, a);
    UPDATE store_order SET state = 'paid', paid_at = now(),
                           provider_ref = coalesce(p_proof, provider_ref)
    WHERE id = p_id;
    RETURN order_view(p_id);
END
$$;

-- db/0206's order_create, with the term the product is sold by.
CREATE OR REPLACE FUNCTION order_create(p_san text, p_qty int DEFAULT 1, p_term interval DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid  uuid := current_user_id();
    a    asset%ROWTYPE;
    o    store_order%ROWTYPE;
    base text;
    amt  numeric;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    SELECT * INTO a FROM asset WHERE san = p_san;
    IF a.san IS NULL THEN
        RAISE EXCEPTION 'no such asset %', p_san USING errcode = 'PT404';
    END IF;
    -- A subscription is bought a term at a time, the product's own unless
    -- asked otherwise; anything else is bought once.
    p_term := CASE WHEN a.policy = 'subscription' THEN coalesce(p_term, a.term) END;
    base := CASE WHEN p_term IS NULL THEN 'buy:' ELSE 'sub:' END || p_san || ':' || uid;
    -- A buy-once order already made is the order: one still waiting for its
    -- money, or one whose right the buyer still holds. A right given away
    -- since is bought again, under a ref of its own.
    SELECT * INTO o FROM store_order so
    WHERE so.ref LIKE base || '%' AND p_term IS NULL AND (so.state = 'pending'
        OR (so.state = 'paid' AND EXISTS (SELECT 1 FROM asset_right r
            WHERE r.san = p_san AND r.holder_id = uid)))
    ORDER BY so.created_at DESC LIMIT 1;
    IF o.id IS NOT NULL THEN RETURN order_view(o.id); END IF;
    amt := order_amount(a, uid, coalesce(p_qty, 1));
    INSERT INTO store_order (san, buyer, qty, amount, term, provider, ref)
    VALUES (p_san, uid, coalesce(p_qty, 1), amt, p_term,
            CASE WHEN amt = 0 THEN 'internal' ELSE store_provider() END,
            base || coalesce(':' || nullif((SELECT count(*) FROM store_order
                WHERE ref LIKE base || '%'), 0)::text, ''))
    RETURNING * INTO o;
    -- The world's own money: paid and confirmed in this same transaction.
    IF o.provider = 'internal' THEN
        RETURN order_confirm(o.id, NULL);
    END IF;
    RETURN order_view(o.id);
END
$$;

-- ------------------------------------------------------------ registering

-- db/0160's register_asset, with the model a product is sold under
-- (`meta.policy`, and a subscription's `meta.term`, thirty days unless said).
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
                       type, parts, policy, term)
    VALUES (new_san, p_sha, register_asset.canon_version,
            coalesce(meta ->> 'name', new_san), coalesce(meta ->> 'category', 'prop'),
            coalesce(meta -> 'bbox', '{}'::jsonb),
            coalesce((meta ->> 'tris')::int, 0), coalesce((meta ->> 'tex_bytes')::int, 0),
            lic, coalesce((meta ->> 'price')::numeric, 0),
            CASE WHEN lic = 'limited' THEN (meta ->> 'editions')::int END,
            uid, meta ->> 'thumb_sha256',
            p_type, marks, coalesce(meta ->> 'policy', 'once'),
            CASE WHEN meta ->> 'policy' = 'subscription'
                 THEN coalesce((meta ->> 'term')::interval, interval '30 days') END)
    ON CONFLICT (san) DO NOTHING;
    RETURN new_san;
END
$$;

-- The api views were made with * before these columns were there.
CREATE OR REPLACE VIEW api.asset WITH (security_invoker = true) AS SELECT * FROM public.asset;
CREATE OR REPLACE VIEW api.asset_right WITH (security_invoker = true)
AS SELECT * FROM public.asset_right;
CREATE VIEW api.asset_version WITH (security_invoker = true)
AS SELECT * FROM public.asset_version;
GRANT SELECT ON api.asset_version TO anon, player, admin;

CREATE FUNCTION api.set_pointer(san text, channel text, sha256 text, fix boolean DEFAULT false,
                                needs jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.set_pointer(san, channel, sha256, fix, needs)$$;
CREATE FUNCTION api.right_sha(san text, holder uuid DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.right_sha(san, coalesce(holder, public.current_user_id()))$$;
CREATE FUNCTION api.policy_words(san text) RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.policy_words(a) FROM public.asset a WHERE a.san = $1$$;
GRANT EXECUTE ON FUNCTION api.set_pointer(text, text, text, boolean, jsonb) TO player, admin;
GRANT EXECUTE ON FUNCTION api.right_sha(text, uuid), api.policy_words(text)
TO anon, player, admin;
