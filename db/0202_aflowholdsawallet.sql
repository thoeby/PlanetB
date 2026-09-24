-- 0202_aflowholdsawallet.sql — a flow can hold a wallet.
--
-- PLAN-money.md M6 and MN.6. A bank, a till, a salary is built by players, as
-- a flow holding a wallet. Somebody who may build on a flow's land gives it a
-- wallet they hold, and takes it back the same way. The flow spends it with
-- its own key: a login whose `flow` claim names it (db/0196 holds), issued to
-- whoever may build there, so a flow can only ever spend its own wallet. The
-- Money blocks (client/flow/world/plugin.xml) call the functions below, and
-- the world runs none of them (Invariant 9: a process server runs flows, as a
-- player with that key).

CREATE FUNCTION flow_land(f uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT area_id FROM flow WHERE id = f;
$$;

REVOKE ALL ON FUNCTION flow_land(uuid) FROM PUBLIC;

CREATE FUNCTION give_to_flow(p_item uuid, f uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM may_spend(p_item);
    IF flow_land(f) IS null THEN
        RAISE EXCEPTION 'there is no such flow' USING errcode = '23503';
    END IF;
    IF NOT is_area_writer(flow_land(f)) THEN
        RAISE EXCEPTION 'that flow is on land you may not build on' USING errcode = '42501';
    END IF;
    UPDATE item SET held_by = null, offered_to = null, held_by_flow = f WHERE id = p_item;
    RETURN jsonb_build_object('flow', (SELECT name FROM flow WHERE id = f));
END
$$;

CREATE FUNCTION take_from_flow(p_item uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    f uuid := (SELECT held_by_flow FROM item WHERE id = p_item);
BEGIN
    PERFORM require_verified();
    IF f IS null OR NOT is_area_writer(flow_land(f)) THEN
        RAISE EXCEPTION 'no flow you may build with holds that' USING errcode = '42501';
    END IF;
    UPDATE item SET held_by_flow = null, held_by = current_user_id() WHERE id = p_item;
    RETURN jsonb_build_object('held', true);
END
$$;

-- The flow's own key: what a process server is given to run it with.
CREATE FUNCTION flow_key(f uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    PERFORM require_verified();
    IF flow_land(f) IS null OR NOT is_area_writer(flow_land(f)) THEN
        RAISE EXCEPTION 'only somebody who may build on its land keys a flow'
            USING errcode = '42501';
    END IF;
    RETURN auth.sign(json_build_object(
        'sub', current_user_id(), 'role', current_user_role(), 'flow', f,
        'exp', extract(epoch FROM now() + interval '365 days')::bigint));
END
$$;

-- The wallets a flow holds, for whoever may build on its land — the land's
-- builders answer for the flow, so they see what it holds.
CREATE FUNCTION flow_wallets(f uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'balance', w.balance)
                          ORDER BY i.created_at), '[]'::jsonb)
FROM item i JOIN wallet w ON w.item_id = i.id
WHERE i.held_by_flow = f
  AND (current_flow() = f OR is_area_writer(flow_land(f)));
$$;

-- Balance and "Money received", for the Money blocks. The holder only.
CREATE FUNCTION wallet_balance(w uuid) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT holds(w) THEN
        RAISE EXCEPTION 'you do not hold that wallet' USING errcode = '42501';
    END IF;
    RETURN (SELECT balance FROM wallet WHERE item_id = w);
END
$$;

CREATE FUNCTION money_received(w uuid, since timestamptz DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT holds(w) THEN
        RAISE EXCEPTION 'you do not hold that wallet' USING errcode = '42501';
    END IF;
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'order', o.id, 'amount', o.amount, 'message', o.message, 'at', o.updated_at,
        'from', CASE WHEN o.kind = 'request' THEN wallet_label(o.other_id)
                     ELSE wallet_label(o.wallet_id) END) ORDER BY o.updated_at), '[]'::jsonb)
    FROM wallet_order o
    WHERE o.state = 'done' AND (since IS null OR o.updated_at > since)
      AND ((o.kind IN ('pay', 'hold') AND o.other_id = w)
           OR (o.kind = 'request' AND o.wallet_id = w)));
END
$$;

GRANT EXECUTE ON FUNCTION give_to_flow(uuid, uuid), take_from_flow(uuid), flow_key(uuid),
    flow_wallets(uuid), wallet_balance(uuid), money_received(uuid, timestamptz)
TO player, admin;

CREATE FUNCTION api.give_to_flow(item uuid, flow uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.give_to_flow(item, flow)$$;
CREATE FUNCTION api.take_from_flow(item uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.take_from_flow(item)$$;
CREATE FUNCTION api.flow_key(flow uuid) RETURNS text
LANGUAGE sql VOLATILE AS $$SELECT public.flow_key(flow)$$;
CREATE FUNCTION api.flow_wallets(flow uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.flow_wallets(flow)$$;
CREATE FUNCTION api.wallet_balance(w uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$SELECT public.wallet_balance(w)$$;
CREATE FUNCTION api.money_received(w uuid, since timestamptz DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.money_received(w, since)$$;
GRANT EXECUTE ON FUNCTION api.give_to_flow(uuid, uuid), api.take_from_flow(uuid),
    api.flow_key(uuid), api.flow_wallets(uuid), api.wallet_balance(uuid),
    api.money_received(uuid, timestamptz) TO player, admin;
