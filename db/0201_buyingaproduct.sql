-- 0201_buyingaproduct.sql — a licence is handed over when the payment is in.
--
-- PLAN-money.md §2 and MN.5. The creator's wallet requests the price from the
-- buyer's; the buyer pressing Buy is their yes; the licence is theirs once the
-- cash has arrived. Rights and editions stay in Postgres (Invariant 5): the
-- edition is taken when the buyer asks — the conditional UPDATE is still the
-- one lock — and given back if the payment never arrives. The right is written
-- once, keyed by the same ref the ledger used, so a second buy is the first.
--
-- A free licence, or your own product, takes no money and is handed over at
-- once, as before.

CREATE FUNCTION buy(san text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    a     asset;
    my_ref text := 'buy:' || buy.san || ':' || current_user_id();
    mine  uuid;
    their uuid;
    o     wallet_order;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF EXISTS (SELECT 1 FROM asset_right r WHERE r.san = buy.san AND r.holder_id = uid) THEN
        RETURN jsonb_build_object('state', 'held');
    END IF;
    SELECT * INTO o FROM wallet_order w WHERE w.ref = my_ref;
    IF o.id IS NOT null AND o.state NOT IN ('failed', 'refused') THEN
        RETURN jsonb_build_object('state', o.state, 'order', o.id);
    END IF;
    UPDATE asset SET issued = issued + 1
    WHERE asset.san = buy.san AND (asset.editions IS NULL OR asset.issued < asset.editions)
    RETURNING * INTO a;
    IF NOT found THEN
        IF EXISTS (SELECT 1 FROM asset x WHERE x.san = buy.san) THEN
            RAISE EXCEPTION '% is sold out', buy.san USING errcode = 'PT409';
        END IF;
        RAISE EXCEPTION 'no such product %', buy.san USING errcode = 'PT404';
    END IF;
    IF a.license NOT IN ('paid', 'limited') OR coalesce(a.price, 0) <= 0
       OR a.creator_id = uid THEN
        INSERT INTO asset_right (san, holder_id, ref) VALUES (buy.san, uid, my_ref);
        RETURN jsonb_build_object('state', 'held');
    END IF;
    SELECT id INTO mine FROM item WHERE held_by = uid AND kind = 'wallet'
    ORDER BY created_at LIMIT 1;
    SELECT id INTO their FROM item WHERE held_by = a.creator_id AND kind = 'wallet'
    ORDER BY created_at LIMIT 1;
    IF mine IS null THEN
        RAISE EXCEPTION 'you hold no wallet to pay with' USING errcode = '23503';
    END IF;
    IF their IS null THEN
        RAISE EXCEPTION '% holds no wallet to be paid into', player_name(a.creator_id)
            USING errcode = '23503';
    END IF;
    PERFORM may_spend(mine);
    PERFORM refuse_what_it_cannot_cover(mine, a.price);
    -- A buy that failed before is asked again under a fresh ref.
    IF o.id IS NOT null THEN
        UPDATE wallet_order w SET ref = w.ref || ':' || w.id WHERE w.id = o.id;
    END IF;
    INSERT INTO wallet_order (kind, wallet_id, other_id, amount, message, ref, for_what,
                              by_user, expires_at)
    VALUES ('request', their, mine, a.price, a.name, my_ref,
            jsonb_build_object('buy', buy.san, 'buyer', uid, 'paid_on_ask', true),
            uid, now() + interval '1 day')
    RETURNING * INTO o;
    RETURN jsonb_build_object('state', 'queued', 'order', o.id,
                              'to', player_name(a.creator_id), 'price', a.price);
END
$$;

GRANT EXECUTE ON FUNCTION buy(text) TO player, admin;

-- The buyer said yes when they pressed Buy: the ask is paid as soon as it is
-- made. And a buy that is paid hands the licence over; one that is not gives
-- the edition back.
CREATE FUNCTION buy_follows_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT NEW.for_what ? 'buy' THEN
        RETURN NEW;
    END IF;
    IF NEW.state = 'asked' AND (NEW.for_what ->> 'paid_on_ask')::boolean THEN
        NEW.state := 'confirmed';
    ELSIF NEW.state = 'done' THEN
        INSERT INTO asset_right (san, holder_id, ref)
        VALUES (NEW.for_what ->> 'buy', (NEW.for_what ->> 'buyer')::uuid,
                'buy:' || (NEW.for_what ->> 'buy') || ':' || (NEW.for_what ->> 'buyer'))
        ON CONFLICT DO NOTHING;
    ELSIF NEW.state IN ('failed', 'refused') AND OLD.state NOT IN ('failed', 'refused') THEN
        UPDATE asset SET issued = issued - 1
        WHERE san = NEW.for_what ->> 'buy' AND issued > 0;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER buy_follows_payment BEFORE UPDATE OF state ON wallet_order
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION buy_follows_payment();

-- The buyer's wallet, not the creator's, is who is waiting: the answer that
-- request.asked would send the payer is not sent for a buy (tell_about_cash).
CREATE OR REPLACE FUNCTION tell_about_cash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    to_whom uuid;
    words   text;
BEGIN
    IF NEW.kind = 'pay' AND NEW.state = 'done' THEN
        to_whom := (SELECT held_by FROM item WHERE id = NEW.other_id);
        words := wallet_label(NEW.wallet_id) || ' paid you '
            || to_char(NEW.amount, 'FM999999990.00')
            || coalesce(': ' || nullif(NEW.message, ''), '');
    ELSIF NEW.kind = 'request' AND NEW.state = 'asked' AND NOT NEW.for_what ? 'buy' THEN
        to_whom := (SELECT held_by FROM item WHERE id = NEW.other_id);
        words := wallet_label(NEW.wallet_id) || ' asks you for '
            || to_char(NEW.amount, 'FM999999990.00')
            || coalesce(': ' || nullif(NEW.message, ''), '');
    ELSIF NEW.kind = 'request' AND NEW.state = 'done' AND NEW.for_what ? 'buy' THEN
        to_whom := (SELECT held_by FROM item WHERE id = NEW.wallet_id);
        words := player_name((NEW.for_what ->> 'buyer')::uuid) || ' bought '
            || NEW.message || ' for ' || to_char(NEW.amount, 'FM999999990.00');
    ELSIF NEW.kind = 'request' AND NEW.state = 'done' THEN
        to_whom := (SELECT held_by FROM item WHERE id = NEW.wallet_id);
        words := wallet_label(NEW.other_id) || ' paid what you asked: '
            || to_char(NEW.amount, 'FM999999990.00');
    END IF;
    IF to_whom IS NOT null THEN
        PERFORM tell(to_whom, 'cash', words, jsonb_build_object('panel', 'Wallet'));
    END IF;
    RETURN NEW;
END
$$;

-- Where a buy has got to, for the catalog's button.
CREATE FUNCTION my_buys() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_object_agg(o.for_what ->> 'buy', jsonb_build_object(
    'state', o.state, 'said', o.said)), '{}'::jsonb)
FROM wallet_order o
WHERE o.for_what ? 'buy' AND o.for_what ->> 'buyer' = current_user_id()::text
  AND o.ref LIKE 'buy:%:' || current_user_id();
$$;

GRANT EXECUTE ON FUNCTION my_buys() TO player, admin;

CREATE FUNCTION api.buy(san text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.buy(san)$$;
CREATE FUNCTION api.my_buys() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_buys()$$;
GRANT EXECUTE ON FUNCTION api.buy(text), api.my_buys() TO player, admin;
