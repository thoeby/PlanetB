-- 0206_ordersreplacebuyasset.sql — buying is an order.
--
-- TASKS-live.md LV.5. `buy_asset` was one transaction that took the money and
-- handed out the right. A purchase paid somewhere else — a card, a bank —
-- cannot be that: the money arrives later, or not at all, and the world has
-- to remember what was asked for until then. So a purchase is an order:
--
--   order_create(san, qty, term)  -> {id, amount, pay_url|null, state}
--   order_confirm(id, proof)      the money is there: the right is handed out
--   order_refund(id)              the money goes back, and the right with it
--
-- The world's own money is provider `internal`: create debits the balance and
-- confirms in the same transaction, which is what buy_asset always did, and
-- what it now is (`order_create(san, 1, null)`). Any other provider name
-- (app_setting `store_provider`) is taken as given and left `pending` until
-- somebody with the proof confirms it; the world sends nothing out to any
-- provider (Invariant 9).
--
-- Invariant 5: every function is one transaction, idempotent by the order's
-- `ref`, and only appends to the ledger — a refund is new rows, never an edit.
-- A buy-once order's ref is the one buy_asset always used, `buy:{san}:{user}`.
-- `order` is a reserved word: the table is `store_order`.
--
-- The operator's cut is a rule on the root area. No area is above every
-- other; the world's ground (db/0039) is the one every land is inside of, so
-- the rule is `ground.rules.store_cut`, a share between 0 and 0.5, paid to
-- whoever set the ground.

ALTER TABLE ground ADD COLUMN rules jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE store_order (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    san          text NOT NULL REFERENCES asset (san),
    buyer        uuid NOT NULL REFERENCES auth.user (id),
    qty          int NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 120),
    amount       numeric(18, 6) NOT NULL CHECK (amount >= 0),
    -- Null: bought once. Otherwise each of `qty` is one term of a subscription.
    term         interval CHECK (term IS NULL OR term > interval '0'),
    state        text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'paid', 'refunded')),
    provider     text NOT NULL DEFAULT 'internal'
                     CHECK (provider ~ '^[a-z][a-z0-9_-]{0,30}$'),
    provider_ref text,
    ref          text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    paid_at      timestamptz,
    refunded_at  timestamptz
);
CREATE INDEX store_order_buyer_idx ON store_order (buyer);
CREATE INDEX store_order_san_idx ON store_order (san);

-- Invariant 6: a buyer reads their orders, a maker the orders of their
-- products, an admin all of them. Nobody writes but the three functions.
ALTER TABLE store_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY mine ON store_order FOR SELECT USING (
    buyer = current_user_id() OR current_user_role() = 'admin'
    OR EXISTS (SELECT 1 FROM asset a WHERE a.san = store_order.san
               AND a.creator_id = current_user_id()));
GRANT SELECT ON store_order TO player, admin;

-- ------------------------------------------------------------- the rules

CREATE FUNCTION store_provider() RETURNS text
LANGUAGE sql STABLE AS $$
SELECT coalesce((SELECT value FROM app_setting WHERE key = 'store_provider'), 'internal')
$$;

CREATE FUNCTION store_cut() RETURNS numeric
LANGUAGE sql STABLE AS $$
SELECT least(0.5, greatest(0, coalesce((SELECT (g.rules ->> 'store_cut')::numeric
                                        FROM ground g LIMIT 1), 0)))
$$;

CREATE FUNCTION operator_account() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT a.id FROM ground g JOIN account a ON a.owner_id = g.set_by LIMIT 1
$$;

-- What an order costs: nothing for what is free or for its own maker.
CREATE FUNCTION order_amount(a asset, p_buyer uuid, p_qty int) RETURNS numeric
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN a.license IN ('paid', 'limited') AND a.price > 0 AND a.creator_id <> p_buyer
    THEN a.price * p_qty ELSE 0 END
$$;

GRANT EXECUTE ON FUNCTION store_provider(), store_cut(), operator_account(),
    order_amount(asset, uuid, int) TO anon, player, admin;

-- ---------------------------------------------------------------- the view

CREATE FUNCTION order_view(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object('id', o.id, 'san', o.san, 'qty', o.qty, 'amount', o.amount,
    'term', o.term, 'state', o.state, 'provider', o.provider, 'ref', o.ref,
    'pay_url', CASE WHEN o.state = 'pending' AND o.provider <> 'internal'
        THEN (SELECT s.value || o.id FROM app_setting s WHERE s.key = 'store_pay_url') END)
FROM store_order o WHERE o.id = p_id
$$;

-- ----------------------------------------------------------------- confirm

-- The money is there: the edition is counted, the maker and the operator are
-- paid (the world's own money only; a provider's arrived elsewhere), and the
-- right is handed out. A second confirm of a paid order changes nothing.
CREATE FUNCTION order_confirm(p_id uuid, p_proof text DEFAULT NULL) RETURNS jsonb
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
    INSERT INTO asset_right (san, holder_id, ref) VALUES (o.san, o.buyer, o.ref)
    ON CONFLICT (san, holder_id) DO NOTHING;
    UPDATE store_order SET state = 'paid', paid_at = now(),
                           provider_ref = coalesce(p_proof, provider_ref)
    WHERE id = p_id;
    RETURN order_view(p_id);
END
$$;

-- ------------------------------------------------------------------ create

CREATE FUNCTION order_create(p_san text, p_qty int DEFAULT 1, p_term interval DEFAULT NULL)
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

-- ------------------------------------------------------------------ refund

-- The money back, and the right with it. The maker, or an admin, says so.
CREATE FUNCTION order_refund(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    o     store_order%ROWTYPE;
    back  uuid;
    l     ledger%ROWTYPE;
BEGIN
    SELECT * INTO o FROM store_order WHERE id = p_id FOR UPDATE;
    IF o.id IS NULL THEN
        RAISE EXCEPTION 'no such order' USING errcode = 'PT404';
    END IF;
    IF o.state = 'refunded' THEN RETURN order_view(p_id); END IF;
    IF current_user_role() IS DISTINCT FROM 'admin' AND NOT EXISTS (
        SELECT 1 FROM asset a WHERE a.san = o.san AND a.creator_id = current_user_id()) THEN
        RAISE EXCEPTION 'only its maker or an admin refunds an order' USING errcode = '42501';
    END IF;
    SELECT id INTO back FROM account WHERE owner_id = o.buyer;
    -- Every row the order paid, paid back under a ref of its own.
    FOR l IN SELECT * FROM ledger WHERE ref IN (o.ref, o.ref || ':cut') LOOP
        PERFORM transfer(l.credit, back, l.amount, 'refund:' || l.ref);
    END LOOP;
    IF o.state = 'paid' THEN
        DELETE FROM asset_right WHERE san = o.san AND holder_id = o.buyer AND ref = o.ref;
        IF FOUND THEN
            UPDATE asset SET issued = issued - 1 WHERE san = o.san;
        END IF;
    END IF;
    UPDATE store_order SET state = 'refunded', refunded_at = now() WHERE id = p_id;
    RETURN order_view(p_id);
END
$$;

-- ---------------------------------------------------------------- buy_asset

-- db/0023's buy_asset, as an order of one, bought once, in the world's money.
-- Same signature and the same answer: the right that is held.
CREATE OR REPLACE FUNCTION buy_asset(san text) RETURNS asset_right
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid  uuid := current_user_id();
    r    asset_right%ROWTYPE;
    done jsonb;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    SELECT * INTO r FROM asset_right ar WHERE ar.san = buy_asset.san AND ar.holder_id = uid;
    IF r.san IS NOT NULL THEN RETURN r; END IF;
    done := order_create(buy_asset.san, 1, NULL);
    SELECT * INTO r FROM asset_right ar WHERE ar.san = buy_asset.san AND ar.holder_id = uid;
    IF r.san IS NULL THEN
        RAISE EXCEPTION 'this world takes payment through %: finish the order at %',
            done ->> 'provider', coalesce(done ->> 'pay_url', 'the provider')
            USING errcode = 'PT402';
    END IF;
    RETURN r;
END
$$;

GRANT EXECUTE ON FUNCTION order_view(uuid), order_create(text, int, interval),
    order_confirm(uuid, text), order_refund(uuid) TO player, admin;

CREATE VIEW api.store_order WITH (security_invoker = true) AS SELECT * FROM public.store_order;
GRANT SELECT ON api.store_order TO player, admin;

CREATE FUNCTION api.order_create(san text, qty int DEFAULT 1, term interval DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE AS $$SELECT public.order_create(san, qty, term)$$;
CREATE FUNCTION api.order_confirm(id uuid, proof text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.order_confirm(id, proof)$$;
CREATE FUNCTION api.order_refund(id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.order_refund(id)$$;
GRANT EXECUTE ON FUNCTION api.order_create(text, int, interval),
    api.order_confirm(uuid, text), api.order_refund(uuid) TO player, admin;
