-- 0197_creditsbecomecash.sql — PLAN-money.md MN.0, the switch.
--
-- Credits were rows of a ledger; from here they are cash. Every
-- price still held on a job goes back to whoever set it, then every positive
-- balance is issued as cash into a wallet its owner holds, and the ledger
-- records the balance going out as the last line it will ever write for that
-- account (ref `switch:`). The ledger stays, read-only, as history.
CREATE FUNCTION credits_become_cash() RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    l   record;
    a   record;
    w   uuid;
    n   int := 0;
BEGIN
    -- The ledger's own refund, spelt out: refund_bounty moves cash from
    -- db/0200 on, and what is in escrow here is credits.
    FOR l IN SELECT e.id, e.debit, e.amount FROM ledger e
             WHERE e.credit = escrow_account() AND e.ref LIKE 'bounty:%'
               AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.ref = 'refund:' || e.id)
             ORDER BY e.id LOOP
        PERFORM transfer(escrow_account(), l.debit, l.amount, 'refund:' || l.id);
    END LOOP;
    UPDATE job SET bounty = 0 WHERE bounty > 0;
    FOR a IN SELECT ac.id, ac.owner_id, b.amount FROM account ac
             JOIN balance b ON b.account_id = ac.id
             WHERE ac.owner_id IS NOT null AND b.amount > 0 LOOP
        SELECT id INTO w FROM item WHERE held_by = a.owner_id AND kind = 'wallet'
        ORDER BY created_at LIMIT 1;
        IF w IS null THEN
            w := new_wallet(a.owner_id);
        END IF;
        PERFORM issue_cash(w, round(a.amount, 2), 'switch:' || a.id, 'credits, as cash');
        PERFORM transfer(a.id, treasury_account(), a.amount, 'switch:' || a.id);
        n := n + 1;
    END LOOP;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION credits_become_cash() FROM PUBLIC;

SELECT credits_become_cash();

-- Nothing writes the ledger from here: the ways a player or the world could
-- are the players' no more (PLAN-money.md §1).
REVOKE EXECUTE ON FUNCTION pay(uuid, numeric, text), set_bounty(bigint, numeric),
    buy_asset(text), api.pay(uuid, numeric, text), api.set_bounty(bigint, numeric),
    api.buy_asset(text) FROM PUBLIC, anon, player, admin;

