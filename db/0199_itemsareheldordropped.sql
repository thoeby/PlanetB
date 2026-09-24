-- 0199_itemsareheldordropped.sql — a wallet is a thing you hold.
--
-- PLAN-money.md M3 and §3, MN.3. Whoever holds a wallet can spend it. Hand it
-- over and the other player has the money, once they take it; drop it and it
-- lies where you stood, for anyone within reach to pick up (O1: on land, only
-- somebody who may build there). Held items cannot be taken. None of this
-- touches the cash: the coins stay in the wallet's own file, and who may spend
-- them is who holds the item (db/0196 holds, Invariant 6).
--
-- Where a player stands is what their page says it is: the world has no other
-- way to know. "Within reach" is checked against that.

CREATE FUNCTION world_point(lon double precision, lat double precision,
                            h double precision DEFAULT 0) RETURNS geometry
LANGUAGE sql STABLE AS $$
SELECT st_setsrid(st_makepoint(lon, lat, coalesce(h, 0)), world_srid());
$$;

-- Metres between two points of the world, on the ground (movers_near does
-- the same, db/0172).
CREATE FUNCTION metres_apart(a geometry, b geometry) RETURNS double precision
LANGUAGE sql STABLE AS $$
SELECT st_distance(st_force2d(a)::geography, st_force2d(b)::geography);
$$;

CREATE FUNCTION reach() RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$SELECT 5.0::double precision$$;

-- O1: lying on somebody's land, it is in their safe.
CREATE FUNCTION may_pick_up(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce((SELECT is_area_writer(gis.area_at(i.lying)) FROM item i
                 WHERE i.id = p_item AND gis.area_at(i.lying) IS NOT null), true);
$$;

-- Handing over is an offer: the other player takes it or refuses it, and
-- until then it stays with whoever holds it. V4: a revoked player may still
-- hand over what they hold.
CREATE FUNCTION hand_over(p_item uuid, to_who text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    them uuid;
BEGIN
    IF NOT holds(p_item) THEN
        RAISE EXCEPTION 'you do not hold that' USING errcode = '42501';
    END IF;
    IF btrim(coalesce(to_who, '')) = '' THEN
        UPDATE item SET offered_to = null WHERE id = p_item;
        RETURN jsonb_build_object('offered_to', null);
    END IF;
    SELECT id INTO them FROM auth.user WHERE lower(btrim(name)) = lower(btrim(to_who));
    IF them IS null THEN
        RAISE EXCEPTION 'there is nobody called %', btrim(to_who) USING errcode = '23503';
    END IF;
    IF them = current_user_id() THEN
        RAISE EXCEPTION 'you hold it already' USING errcode = '23514';
    END IF;
    UPDATE item SET offered_to = them WHERE id = p_item;
    PERFORM tell(them, 'item', player_name(current_user_id()) || ' hands you a wallet',
                 jsonb_build_object('panel', 'Inventory', 'item', p_item));
    RETURN jsonb_build_object('offered_to', player_name(them));
END
$$;

CREATE FUNCTION take_item(p_item uuid, accept boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    i item;
BEGIN
    SELECT * INTO i FROM item WHERE id = p_item FOR UPDATE;
    IF i.id IS null OR i.offered_to IS DISTINCT FROM current_user_id() THEN
        RAISE EXCEPTION 'nobody is handing you that' USING errcode = '42501';
    END IF;
    IF accept THEN
        -- Holding a wallet wants a verified person (PLAN-identity.md V5).
        PERFORM require_verified();
        UPDATE item SET held_by = current_user_id(), held_by_flow = null,
            offered_to = null WHERE id = p_item;
    ELSE
        UPDATE item SET offered_to = null WHERE id = p_item;
    END IF;
    PERFORM tell(i.held_by, 'item', player_name(current_user_id())
                 || CASE WHEN accept THEN ' took the wallet you handed over'
                         ELSE ' did not take the wallet' END,
                 jsonb_build_object('panel', 'Inventory'));
    RETURN jsonb_build_object('held', accept);
END
$$;

CREATE FUNCTION drop_item(p_item uuid, lon double precision, lat double precision,
                          h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT holds(p_item) OR current_flow() IS NOT null THEN
        RAISE EXCEPTION 'you do not hold that' USING errcode = '42501';
    END IF;
    UPDATE item SET held_by = null, offered_to = null,
        lying = world_point(lon, lat, h) WHERE id = p_item;
    RETURN jsonb_build_object('lying', true,
        'safe', gis.area_at(world_point(lon, lat, h)) IS NOT null);
END
$$;

CREATE FUNCTION pick_up(p_item uuid, lon double precision, lat double precision,
                        h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    i item;
BEGIN
    PERFORM require_verified();
    SELECT * INTO i FROM item WHERE id = p_item FOR UPDATE;
    IF i.id IS null OR i.lying IS null THEN
        RAISE EXCEPTION 'that is not lying anywhere' USING errcode = '23503';
    END IF;
    IF metres_apart(i.lying, world_point(lon, lat, h)) > reach() THEN
        RAISE EXCEPTION 'that is % m away — walk up to it',
            round(metres_apart(i.lying, world_point(lon, lat, h))::numeric)
            USING errcode = '23514';
    END IF;
    IF NOT may_pick_up(p_item) THEN
        RAISE EXCEPTION 'that lies on somebody else''s land' USING errcode = '42501';
    END IF;
    UPDATE item SET lying = null, held_by = current_user_id() WHERE id = p_item;
    RETURN jsonb_build_object('held', true);
END
$$;

-- What lies near a place: for the page to draw over the splats (movers are
-- drawn the same way) and to offer to pick up.
CREATE FUNCTION items_near(lon double precision, lat double precision,
                           metres double precision DEFAULT 60) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'kind', i.kind,
    'lon', st_x(i.lying), 'lat', st_y(i.lying),
    'h', st_z(i.lying),
    'metres', round(metres_apart(i.lying, world_point(lon, lat))::numeric, 1),
    'safe', gis.area_at(i.lying) IS NOT null,
    'may_pick_up', may_pick_up(i.id)) ORDER BY metres_apart(i.lying, world_point(lon, lat))),
    '[]'::jsonb)
FROM item i
WHERE i.lying IS NOT null
  AND metres_apart(i.lying, world_point(lon, lat)) <= metres;
$$;

GRANT EXECUTE ON FUNCTION world_point(double precision, double precision, double precision),
    metres_apart(geometry, geometry), reach() TO anon, player, admin;
GRANT EXECUTE ON FUNCTION hand_over(uuid, text), take_item(uuid, boolean),
    drop_item(uuid, double precision, double precision, double precision),
    pick_up(uuid, double precision, double precision, double precision) TO player, admin;
GRANT EXECUTE ON FUNCTION items_near(double precision, double precision, double precision)
    TO anon, player, admin;

CREATE FUNCTION api.hand_over(item uuid, to_who text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.hand_over(item, to_who)$$;
CREATE FUNCTION api.take_item(item uuid, accept boolean) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.take_item(item, accept)$$;
CREATE FUNCTION api.drop_item(item uuid, lon double precision, lat double precision,
                              h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.drop_item(item, lon, lat, h)$$;
CREATE FUNCTION api.pick_up(item uuid, lon double precision, lat double precision,
                            h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.pick_up(item, lon, lat, h)$$;
CREATE FUNCTION api.items_near(lon double precision, lat double precision,
                               metres double precision DEFAULT 60) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.items_near(lon, lat, metres)$$;
GRANT EXECUTE ON FUNCTION api.hand_over(uuid, text), api.take_item(uuid, boolean),
    api.drop_item(uuid, double precision, double precision, double precision),
    api.pick_up(uuid, double precision, double precision, double precision) TO player, admin;
GRANT EXECUTE ON FUNCTION api.items_near(double precision, double precision, double precision)
    TO anon, player, admin;
