-- 0196_cashinawallet.sql — one money primitive: cash in a wallet.
--
-- PLAN-money.md M1–M5. Cash is GNU Taler digital cash in the world's own
-- currency, and it is not in Postgres (Invariant 5 as amended): a wallet's
-- coins are in its own wallet-core file, which walletd keeps. What Postgres
-- holds is the wallet as a thing in the world — who holds it, or where it
-- lies — and, for every payment, its reference next to what it paid for
-- (wallet_order). `wallet.balance` is what walletd last read out of the
-- wallet itself, for its holder to see; the wallet is the authority.
--
-- Invariant 9 as amended: walletd spends only on the instruction of whoever
-- holds the wallet. That instruction is a wallet_order row, and the only way
-- to write one is through the functions below, which ask who holds it
-- (Invariant 6). walletd decides nothing: it carries orders out and says what
-- became of them.

-- ------------------------------------------------------------------ items

-- A thing that is held, or lies somewhere; never baked into a tile (§3).
CREATE TABLE item (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL CHECK (kind IN ('wallet')),
    held_by      uuid REFERENCES auth.user (id) ON DELETE SET null,
    held_by_flow uuid REFERENCES flow (id) ON DELETE SET null,
    lying        geometry,
    offered_to   uuid REFERENCES auth.user (id) ON DELETE SET null,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(held_by, held_by_flow, lying) <= 1)
);

CREATE INDEX item_lying ON item USING gist (lying) WHERE lying IS NOT null;
CREATE INDEX item_held_by ON item (held_by);

CREATE TABLE wallet (
    item_id  uuid PRIMARY KEY REFERENCES item (id) ON DELETE CASCADE,
    balance  numeric(18, 2),
    pending  boolean NOT NULL DEFAULT true,
    seen_at  timestamptz
);

-- Every payment's reference, next to what it paid for (for_what). `ref` makes
-- an order idempotent: the same ask twice is one order.
CREATE TABLE wallet_order (
    id            bigserial PRIMARY KEY,
    kind          text NOT NULL
                      CHECK (kind IN ('issue', 'pay', 'request', 'hold')),
    wallet_id     uuid NOT NULL REFERENCES wallet (item_id),
    other_id      uuid REFERENCES wallet (item_id),
    amount        numeric(18, 2) NOT NULL CHECK (amount > 0),
    message       text NOT NULL DEFAULT '',
    ref           text NOT NULL UNIQUE,
    for_what      jsonb NOT NULL DEFAULT '{}'::jsonb,
    by_user       uuid REFERENCES auth.user (id) ON DELETE SET null,
    -- queued, confirmed and releasing are walletd's to act on; the rest are
    -- where an order rests.
    state         text NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued', 'asked', 'confirmed', 'held',
                                       'releasing', 'done', 'returned',
                                       'failed', 'refused')),
    said          text NOT NULL DEFAULT '',
    taler_tx      text,
    other_tx      text,
    expires_at    timestamptz,
    retry_at      timestamptz,
    working_since timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_order_todo ON wallet_order (id)
WHERE state IN ('queued', 'confirmed', 'releasing');
CREATE INDEX wallet_order_wallet ON wallet_order (wallet_id);
CREATE INDEX wallet_order_other ON wallet_order (other_id);

-- Invariant 6: nothing is readable or writable directly. The functions below
-- say what the holder of a wallet may see and do.
ALTER TABLE item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_order ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ holding

-- A flow holds a wallet through its own key: a JWT whose `flow` claim names
-- it (flow_key, below). A player's own key has no such claim.
CREATE FUNCTION current_flow() RETURNS uuid
LANGUAGE sql STABLE AS $$
SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'flow', '')::uuid;
$$;

CREATE FUNCTION holds(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT EXISTS (
    SELECT 1 FROM item i WHERE i.id = p_item
      AND ((current_flow() IS null AND i.held_by = current_user_id())
           OR (current_flow() IS NOT null AND i.held_by_flow = current_flow())));
$$;

-- V4: a revoked player keeps holding, and may hand over or drop, but spends
-- nothing until verified again. A flow spends as the person whose key it is.
CREATE FUNCTION may_spend(p_item uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT holds(p_item) THEN
        RAISE EXCEPTION 'you do not hold that wallet' USING errcode = '42501';
    END IF;
    PERFORM require_verified();
END
$$;

GRANT EXECUTE ON FUNCTION current_flow(), holds(uuid) TO player, admin;

-- A wallet by what a player types: a wallet's id, or a player's name (the
-- wallet they have held longest).
CREATE FUNCTION wallet_of(who text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    w uuid;
BEGIN
    IF who ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT item_id INTO w FROM wallet WHERE item_id = who::uuid;
        IF w IS NOT null THEN RETURN w; END IF;
    END IF;
    SELECT i.id INTO w FROM item i JOIN auth.user u ON u.id = i.held_by
    WHERE i.kind = 'wallet' AND lower(btrim(u.name)) = lower(btrim(who))
    ORDER BY i.created_at LIMIT 1;
    IF w IS null THEN
        RAISE EXCEPTION 'nobody called % holds a wallet', btrim(who) USING errcode = '23503';
    END IF;
    RETURN w;
END
$$;

-- Who a wallet is, to somebody reading its history: a player, a flow, or
-- lying on the ground.
CREATE FUNCTION wallet_label(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(player_name(i.held_by),
                (SELECT 'flow ' || f.name FROM flow f WHERE f.id = i.held_by_flow),
                CASE WHEN i.lying IS NOT null THEN 'a wallet on the ground' END,
                'a wallet')
FROM item i WHERE i.id = w;
$$;

CREATE FUNCTION new_wallet(holder uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    w uuid;
BEGIN
    INSERT INTO item (kind, held_by) VALUES ('wallet', holder) RETURNING id INTO w;
    INSERT INTO wallet (item_id) VALUES (w);
    RETURN w;
END
$$;

REVOKE ALL ON FUNCTION wallet_of(text), wallet_label(uuid), new_wallet(uuid),
    may_spend(uuid) FROM PUBLIC;

-- ------------------------------------------------------------------ issuing

-- M5: the only way money comes into being. walletd funds the wallet from the
-- world's issuing account; `ref` makes it once per reason.
CREATE FUNCTION issue_cash(w uuid, amount numeric, ref text, message text)
RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
INSERT INTO wallet_order (kind, wallet_id, amount, ref, message)
VALUES ('issue', w, amount, ref, message)
ON CONFLICT (ref) DO NOTHING
RETURNING id;
$$;

REVOKE ALL ON FUNCTION issue_cash(uuid, numeric, text, text) FROM PUBLIC;

CREATE FUNCTION starting_amount() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce((SELECT value::numeric FROM app_setting WHERE key = 'starting_amount'), 100);
$$;

GRANT EXECUTE ON FUNCTION starting_amount() TO anon, player, admin;

-- PLAN-identity.md: the starting cash is issued when a player is first
-- verified — once per person, however often they are verified again.
CREATE FUNCTION start_with_cash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    w uuid;
BEGIN
    IF NEW.state <> 'verified' THEN
        RETURN NEW;
    END IF;
    SELECT id INTO w FROM item WHERE held_by = NEW.player_id AND kind = 'wallet'
    ORDER BY created_at LIMIT 1;
    IF w IS null AND NOT EXISTS (SELECT 1 FROM wallet_order
                                 WHERE ref = 'start:' || NEW.player_id) THEN
        w := new_wallet(NEW.player_id);
    END IF;
    IF w IS NOT null AND starting_amount() > 0 THEN
        PERFORM issue_cash(w, starting_amount(), 'start:' || NEW.player_id,
                           'the starting amount');
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER start_with_cash AFTER INSERT OR UPDATE OF state ON player_verification
FOR EACH ROW EXECUTE FUNCTION start_with_cash();

-- ------------------------------------------------------------------ walletd

-- walletd connects as the database's owner and becomes this role at once:
-- it may take the next order, say what became of it, and write down what a
-- wallet holds. Nothing else.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'walletd') THEN
        CREATE ROLE walletd NOLOGIN;
    END IF;
END
$$;

-- Tell walletd there is something to do.
CREATE FUNCTION wallet_order_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    IF NEW.state IN ('queued', 'confirmed', 'releasing') THEN
        PERFORM pg_notify('wallet_order', NEW.id::text);
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER wallet_order_notify BEFORE INSERT OR UPDATE OF state ON wallet_order
FOR EACH ROW EXECUTE FUNCTION wallet_order_notify();

-- The next order to carry out, with the wallets it needs. An order being
-- worked on is walletd's for two minutes; a walletd that died holding it
-- gives it back by not coming back.
CREATE FUNCTION walletd_next() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    o wallet_order;
BEGIN
    SELECT * INTO o FROM wallet_order
    WHERE state IN ('queued', 'confirmed', 'releasing')
      AND (retry_at IS null OR retry_at <= now())
      AND (working_since IS null OR working_since < now() - interval '2 minutes')
    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF o.id IS null THEN
        RETURN null;
    END IF;
    UPDATE wallet_order SET working_since = now() WHERE id = o.id;
    RETURN to_jsonb(o);
END
$$;

-- What became of an order. `state` null keeps it where it was (a retry).
CREATE FUNCTION walletd_said(order_id bigint, state text, said text,
                             taler_tx text DEFAULT null, other_tx text DEFAULT null,
                             retry_in int DEFAULT null) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
UPDATE wallet_order o SET
    state = coalesce(walletd_said.state, o.state),
    said = coalesce(walletd_said.said, o.said),
    taler_tx = coalesce(walletd_said.taler_tx, o.taler_tx),
    other_tx = coalesce(walletd_said.other_tx, o.other_tx),
    retry_at = CASE WHEN retry_in IS null THEN null
                    ELSE now() + make_interval(secs => retry_in) END,
    working_since = null
WHERE o.id = order_id;
$$;

-- What a wallet holds, as the wallet itself says.
CREATE FUNCTION walletd_seen(w uuid, balance numeric, pending boolean) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
UPDATE wallet SET balance = walletd_seen.balance, pending = walletd_seen.pending,
    seen_at = now()
WHERE item_id = w;
$$;

-- The wallets that have something going on: pending work in the wallet, or a
-- payment held that may come back.
CREATE FUNCTION walletd_busy() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(DISTINCT w), '[]'::jsonb) FROM (
    SELECT item_id AS w FROM wallet WHERE pending
    UNION SELECT wallet_id FROM wallet_order WHERE state IN ('held', 'asked')
) q;
$$;

-- The payments held with an expiry, for walletd to see whether they came back.
CREATE FUNCTION walletd_held() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb)
FROM wallet_order o WHERE o.state IN ('held', 'asked');
$$;

CREATE FUNCTION walletd_hello(currency text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
INSERT INTO app_setting (key, value) VALUES ('currency_code', currency)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, set_at = now();
$$;

REVOKE ALL ON FUNCTION walletd_next(), walletd_said(bigint, text, text, text, text, int),
    walletd_seen(uuid, numeric, boolean), walletd_busy(), walletd_held(),
    walletd_hello(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION walletd_next(), walletd_said(bigint, text, text, text, text, int),
    walletd_seen(uuid, numeric, boolean), walletd_busy(), walletd_held(),
    walletd_hello(text) TO walletd;
GRANT USAGE ON SCHEMA public TO walletd;

-- ------------------------------------------------------------------ reading

-- What you hold (and what is being handed to you), with each wallet's cash —
-- which only its holder sees (§3).
CREATE FUNCTION my_items() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'kind', i.kind, 'held', i.held_by = current_user_id(),
    'offered_by', CASE WHEN i.offered_to = current_user_id()
                       THEN player_name(i.held_by) END,
    'offered_to', CASE WHEN i.held_by = current_user_id()
                       THEN player_name(i.offered_to) END,
    'balance', CASE WHEN i.held_by = current_user_id() THEN w.balance END,
    'pending', w.pending, 'seen_at', w.seen_at,
    'currency', (SELECT value FROM app_setting WHERE key = 'currency_code'))
    ORDER BY i.created_at), '[]'::jsonb)
FROM item i LEFT JOIN wallet w ON w.item_id = i.id
WHERE current_flow() IS null
  AND (i.held_by = current_user_id() OR i.offered_to = current_user_id());
$$;

-- A wallet's movements, newest first, for whoever holds it: what came in is
-- positive, what went out negative, each with its message and what became of
-- it. Asks waiting for this wallet to pay are in it too.
CREATE FUNCTION wallet_history(w uuid, lim int DEFAULT 40) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT holds(w) THEN
        RAISE EXCEPTION 'you do not hold that wallet' USING errcode = '42501';
    END IF;
    RETURN (SELECT coalesce(jsonb_agg(h ORDER BY (h ->> 'id')::bigint DESC), '[]'::jsonb)
    FROM (
        SELECT jsonb_build_object(
            'id', o.id, 'kind', o.kind, 'state', o.state, 'said', o.said,
            'message', o.message, 'at', o.updated_at, 'for', o.for_what,
            -- In: issued to it, paid to it, or asked for by it and paid.
            -- Out: paid or held from it, or asked of it.
            'amount', CASE WHEN (o.kind = 'issue')
                             OR (o.kind IN ('pay', 'hold') AND o.other_id = w)
                             OR (o.kind = 'request' AND o.wallet_id = w)
                           THEN o.amount ELSE -o.amount END,
            'with', CASE WHEN o.kind = 'issue' THEN 'the world'
                         WHEN o.wallet_id = w THEN wallet_label(o.other_id)
                         ELSE wallet_label(o.wallet_id) END,
            'asks_me', o.kind = 'request' AND o.other_id = w AND o.state = 'asked') AS h
        FROM wallet_order o
        WHERE o.wallet_id = w OR o.other_id = w
        ORDER BY o.id DESC LIMIT lim) q);
END
$$;

GRANT EXECUTE ON FUNCTION my_items(), wallet_history(uuid, int) TO player, admin;

CREATE FUNCTION api.my_items() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_items()$$;
CREATE FUNCTION api.wallet_history(w uuid, lim int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.wallet_history(w, lim)$$;
CREATE FUNCTION api.starting_amount() RETURNS numeric
LANGUAGE sql STABLE AS $$SELECT public.starting_amount()$$;
GRANT EXECUTE ON FUNCTION api.my_items(), api.wallet_history(uuid, int) TO player, admin;
GRANT EXECUTE ON FUNCTION api.starting_amount() TO anon, player, admin;
