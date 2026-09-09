-- 0023_money.sql — buying a catalog right and passing it on (WP4.4).
--
-- `pay`, `set_bounty` and the escrow release on publish are WP0.8's
-- (db/0006_publish.sql); the wallet a user spends from is created by
-- `register()` (db/0002_auth.sql). What is left is the two ways an
-- `asset_right` comes into existence.
--
-- Invariant 5: each function below is one transaction, idempotent by `ref`,
-- and only appends to the ledger. ARCHITECTURE §4 fixes a purchase's ref at
-- `buy:{san}:{user}`; a resale chains onto the ref of the right it consumes,
-- so it is unique for the same reason that one was.

-- ARCHITECTURE §4. `issued` counts rights handed out, so it is bumped for
-- every licence — for 'limited' it is also the edition counter the CHECK on
-- `asset` bounds. Licences: 'cc0' and 'free' are acquired rather than sold and
-- never touch the ledger, whatever price the row happens to carry; 'paid' and
-- 'limited' charge `asset.price`, and 'limited' alone runs out. A creator
-- takes their own asset for free (the ledger forbids debit = credit), and a
-- second buy by the same holder is a no-op that returns the right already
-- held: no second charge, no second edition.
CREATE FUNCTION buy_asset(san text) RETURNS asset_right
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    a     asset%rowtype;
    r     asset_right%rowtype;
    payee uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;

    SELECT * INTO r FROM asset_right ar
    WHERE ar.san = buy_asset.san AND ar.holder_id = uid;
    IF r.san IS NOT NULL THEN
        RETURN r;
    END IF;

    -- The conditional UPDATE is the edition lock, and the only one. A second
    -- buyer of the last edition blocks on this row, re-reads it once we
    -- commit, sees issued = editions and updates nothing.
    UPDATE asset SET issued = issued + 1
    WHERE asset.san = buy_asset.san
      AND (asset.editions IS NULL OR asset.issued < asset.editions)
    RETURNING * INTO a;

    IF NOT found THEN
        IF EXISTS (SELECT 1 FROM asset x WHERE x.san = buy_asset.san) THEN
            RAISE EXCEPTION 'asset % is sold out', buy_asset.san
                USING errcode = 'PT409';
        END IF;
        RAISE EXCEPTION 'no such asset %', buy_asset.san USING errcode = 'PT404';
    END IF;

    IF a.license IN ('paid', 'limited') AND a.price > 0 AND a.creator_id <> uid THEN
        SELECT ac.id INTO payee FROM account ac WHERE ac.owner_id = a.creator_id;
        IF payee IS NULL THEN
            RAISE EXCEPTION 'the creator of % has no account', buy_asset.san
                USING errcode = 'PT404';
        END IF;
        PERFORM pay(payee, a.price, 'buy:' || buy_asset.san || ':' || uid);
    END IF;

    INSERT INTO asset_right (san, holder_id, ref)
    VALUES (buy_asset.san, uid, 'buy:' || buy_asset.san || ':' || uid)
    RETURNING * INTO r;
    RETURN r;
END
$$;

-- One right changes hands, and the money moves with it, in one transaction.
--
-- Who calls decides which half happens, because money may only leave the
-- wallet of whoever called (Invariant 6 — the caller's own authority is all
-- there is; a holder who could name any `to_user` and any `amount` could empty
-- a stranger's wallet):
--   * the holder calls  -> the right is given to `to_user`, `amount` must be 0;
--   * `to_user` holds it and someone else calls -> the caller pays `to_user`
--     via `pay` and takes the right.
-- Either way `to_user` is the counterparty and the right ends up with the
-- other one of the two. The conditional UPDATE is again the lock: a right
-- already passed on is gone from under the second caller.
CREATE FUNCTION transfer_asset_right(san text, to_user uuid,
                                     amount numeric DEFAULT 0)
RETURNS asset_right
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid     uuid := current_user_id();
    seller  uuid;
    buyer   uuid;
    r       asset_right%rowtype;
    payee   uuid;
    new_ref text;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF to_user = uid THEN
        RAISE EXCEPTION 'a right cannot be transferred to its holder'
            USING errcode = 'PT400';
    END IF;

    IF EXISTS (SELECT 1 FROM asset_right ar
               WHERE ar.san = transfer_asset_right.san AND ar.holder_id = uid) THEN
        seller := uid;
        buyer := to_user;
        IF amount <> 0 THEN
            RAISE EXCEPTION
                'only the buyer can spend the buyer''s money: % must call this',
                to_user USING errcode = 'PT403';
        END IF;
    ELSE
        seller := to_user;
        buyer := uid;
    END IF;

    IF EXISTS (SELECT 1 FROM asset_right ar
               WHERE ar.san = transfer_asset_right.san AND ar.holder_id = buyer) THEN
        RAISE EXCEPTION '% already holds a right on %', buyer,
            transfer_asset_right.san USING errcode = 'PT409';
    END IF;

    SELECT * INTO r FROM asset_right ar
    WHERE ar.san = transfer_asset_right.san AND ar.holder_id = seller
    FOR UPDATE;
    IF r.san IS NULL THEN
        RAISE EXCEPTION '% holds no right on %', seller,
            transfer_asset_right.san USING errcode = 'PT404';
    END IF;
    new_ref := 'xfer:' || r.ref || ':' || buyer;

    IF amount > 0 THEN
        SELECT ac.id INTO payee FROM account ac WHERE ac.owner_id = seller;
        IF payee IS NULL THEN
            RAISE EXCEPTION '% has no account', seller USING errcode = 'PT404';
        END IF;
        PERFORM pay(payee, amount, new_ref);
    END IF;

    UPDATE asset_right ar
    SET holder_id = buyer, ref = new_ref, acquired_at = now()
    WHERE ar.san = transfer_asset_right.san AND ar.holder_id = seller
    RETURNING * INTO r;
    RETURN r;
END
$$;

GRANT EXECUTE ON FUNCTION buy_asset(text),
    transfer_asset_right(text, uuid, numeric) TO player, admin;

CREATE FUNCTION api.buy_asset(san text) RETURNS public.asset_right
LANGUAGE sql AS $$SELECT public.buy_asset(san)$$;
GRANT EXECUTE ON FUNCTION api.buy_asset(text) TO player, admin;

CREATE FUNCTION api.transfer_asset_right(san text, to_user uuid,
                                         amount numeric DEFAULT 0)
RETURNS public.asset_right LANGUAGE sql
AS $$SELECT public.transfer_asset_right(san, to_user, amount)$$;
GRANT EXECUTE ON FUNCTION api.transfer_asset_right(text, uuid, numeric)
TO player, admin;
