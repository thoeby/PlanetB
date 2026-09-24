-- 0198_payandrequest.sql — a wallet pays, and asks to be paid.
--
-- PLAN-money.md M4 and MN.2. Pay sends cash to another wallet with a message;
-- Request asks a wallet for cash, and its holder confirms or refuses. Each is
-- an order only the holder of the wallet it spends from can write (Invariant
-- 6, db/0196 may_spend): walletd carries it out, and the wallet says whether
-- it could.

CREATE FUNCTION check_amount(amount numeric) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF amount IS null OR amount <= 0 THEN
        RAISE EXCEPTION 'an amount is more than nothing' USING errcode = '23514';
    END IF;
    IF amount <> round(amount, 2) THEN
        RAISE EXCEPTION 'cash comes in hundredths, not %', amount USING errcode = '23514';
    END IF;
END
$$;

-- What the wallet last said it holds, less what is on its way out: enough to
-- refuse at once a payment that plainly cannot be made. The wallet has the
-- last word (walletd says so if it cannot).
CREATE FUNCTION refuse_what_it_cannot_cover(w uuid, amount numeric) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    has numeric := (SELECT balance FROM wallet WHERE item_id = w);
    out numeric := (SELECT coalesce(sum(o.amount), 0) FROM wallet_order o
                    WHERE o.state IN ('queued', 'confirmed')
                      AND ((o.kind IN ('pay', 'hold') AND o.wallet_id = w)
                           OR (o.kind = 'request' AND o.other_id = w)));
BEGIN
    IF has IS NOT null AND amount > has - out THEN
        RAISE EXCEPTION 'this wallet holds %, not enough for %',
            to_char(greatest(has - out, 0), 'FM999999990.00'),
            to_char(amount, 'FM999999990.00') USING errcode = '23514';
    END IF;
END
$$;

REVOKE ALL ON FUNCTION refuse_what_it_cannot_cover(uuid, numeric) FROM PUBLIC;

CREATE FUNCTION wallet_pay(w uuid, to_who text, amount numeric,
                           message text DEFAULT '', ref text DEFAULT null)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    them uuid;
    oid  bigint;
BEGIN
    PERFORM may_spend(w);
    PERFORM check_amount(amount);
    them := wallet_of(to_who);
    IF them = w THEN
        RAISE EXCEPTION 'a wallet does not pay itself' USING errcode = '23514';
    END IF;
    PERFORM refuse_what_it_cannot_cover(w, amount);
    INSERT INTO wallet_order (kind, wallet_id, other_id, amount, message, ref, by_user)
    VALUES ('pay', w, them, amount, btrim(coalesce(message, '')),
            coalesce(ref, 'pay:' || gen_random_uuid()), current_user_id())
    ON CONFLICT ON CONSTRAINT wallet_order_ref_key DO NOTHING
    RETURNING id INTO oid;
    RETURN jsonb_build_object('order', oid, 'to', wallet_label(them), 'state', 'queued');
END
$$;

CREATE FUNCTION wallet_request(w uuid, from_who text, amount numeric,
                               message text DEFAULT '', ref text DEFAULT null)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    them uuid;
    oid  bigint;
BEGIN
    PERFORM may_spend(w);
    PERFORM check_amount(amount);
    them := wallet_of(from_who);
    IF them = w THEN
        RAISE EXCEPTION 'a wallet does not ask itself' USING errcode = '23514';
    END IF;
    INSERT INTO wallet_order (kind, wallet_id, other_id, amount, message, ref, by_user,
                              expires_at)
    VALUES ('request', w, them, amount, btrim(coalesce(message, '')),
            coalesce(ref, 'ask:' || gen_random_uuid()), current_user_id(),
            now() + interval '7 days')
    ON CONFLICT ON CONSTRAINT wallet_order_ref_key DO NOTHING
    RETURNING id INTO oid;
    RETURN jsonb_build_object('order', oid, 'from', wallet_label(them), 'state', 'queued');
END
$$;

-- The payer's answer. Only whoever holds the wallet asked may give it.
CREATE FUNCTION answer_request(order_id bigint, pay boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    o wallet_order;
BEGIN
    SELECT * INTO o FROM wallet_order WHERE id = order_id AND kind = 'request' FOR UPDATE;
    IF o.id IS null THEN
        RAISE EXCEPTION 'there is no such request' USING errcode = '23503';
    END IF;
    IF pay THEN
        PERFORM may_spend(o.other_id);
    ELSIF NOT holds(o.other_id) THEN
        RAISE EXCEPTION 'you do not hold that wallet' USING errcode = '42501';
    END IF;
    IF o.state <> 'asked' THEN
        RAISE EXCEPTION 'that request is % already', o.state USING errcode = '23514';
    END IF;
    IF pay THEN
        PERFORM refuse_what_it_cannot_cover(o.other_id, o.amount);
    END IF;
    UPDATE wallet_order SET state = CASE WHEN pay THEN 'confirmed' ELSE 'refused' END,
        said = CASE WHEN pay THEN '' ELSE 'Refused.' END
    WHERE id = order_id;
    RETURN jsonb_build_object('order', order_id,
                              'state', CASE WHEN pay THEN 'confirmed' ELSE 'refused' END);
END
$$;

GRANT EXECUTE ON FUNCTION wallet_pay(uuid, text, numeric, text, text),
    wallet_request(uuid, text, numeric, text, text),
    answer_request(bigint, boolean) TO player, admin;

-- Who is told what (SPEC §2.15): a payment arrives with its message, and an
-- ask arrives at the wallet it asks.
CREATE FUNCTION tell_about_cash() RETURNS trigger
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
    ELSIF NEW.kind = 'request' AND NEW.state = 'asked' THEN
        to_whom := (SELECT held_by FROM item WHERE id = NEW.other_id);
        words := wallet_label(NEW.wallet_id) || ' asks you for '
            || to_char(NEW.amount, 'FM999999990.00')
            || coalesce(': ' || nullif(NEW.message, ''), '');
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

CREATE TRIGGER tell_about_cash AFTER UPDATE OF state ON wallet_order
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION tell_about_cash();

CREATE FUNCTION api.wallet_pay(w uuid, to_who text, amount numeric,
                               message text DEFAULT '', ref text DEFAULT null)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.wallet_pay(w, to_who, amount, message, ref)$$;
CREATE FUNCTION api.wallet_request(w uuid, from_who text, amount numeric,
                                   message text DEFAULT '', ref text DEFAULT null)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.wallet_request(w, from_who, amount, message, ref)$$;
CREATE FUNCTION api.answer_request(order_id bigint, pay boolean) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.answer_request(order_id, pay)$$;
GRANT EXECUTE ON FUNCTION api.wallet_pay(uuid, text, numeric, text, text),
    api.wallet_request(uuid, text, numeric, text, text),
    api.answer_request(bigint, boolean) TO player, admin;
