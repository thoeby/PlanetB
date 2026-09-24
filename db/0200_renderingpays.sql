-- 0200_renderingpays.sql — a price on a render job is cash held for it.
--
-- PLAN-money.md §2 and MN.4. Whoever puts a price on a job pays it from their
-- wallet into a payment held with the job: out of their wallet, not yet
-- anybody's. When the tile publishes, the renderer's wallet collects it. Not
-- collected before it expires, it returns by itself; withdrawing the price
-- is letting it return now.
--
-- Everything that paid or refunded a bounty — a tile publishing, a job
-- dropped or superseded — already calls release_escrow or refund_bounty.
-- Those two now move the held cash instead of ledger rows, so every one of
-- those doors pays the way it paid before. `job.bounty` is what the pool has
-- always shown as the price: here it is the cash held for the job.

CREATE FUNCTION job_price(p_job bigint) RETURNS wallet_order
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT * FROM wallet_order
WHERE kind = 'hold' AND for_what ->> 'job' = p_job::text
  AND state IN ('queued', 'held', 'confirmed', 'releasing')
ORDER BY id DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION job_price(bigint) FROM PUBLIC;

CREATE FUNCTION set_price(job_id bigint, amount numeric, w uuid DEFAULT null)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j   job;
    oid bigint;
BEGIN
    SELECT * INTO j FROM job WHERE id = job_id;
    IF j.id IS null OR j.state <> 'open' THEN
        RAISE EXCEPTION 'that job is not open' USING errcode = '23514';
    END IF;
    IF (job_price(job_id)).id IS NOT null THEN
        RAISE EXCEPTION 'this job has a price on it already — withdraw it first'
            USING errcode = '23514';
    END IF;
    w := coalesce(w, (SELECT id FROM item WHERE held_by = current_user_id()
                      AND kind = 'wallet' ORDER BY created_at LIMIT 1));
    IF w IS null THEN
        RAISE EXCEPTION 'you hold no wallet to pay it from' USING errcode = '23503';
    END IF;
    PERFORM may_spend(w);
    PERFORM check_amount(amount);
    PERFORM refuse_what_it_cannot_cover(w, amount);
    INSERT INTO wallet_order (kind, wallet_id, amount, message, ref, for_what, by_user,
                              expires_at)
    VALUES ('hold', w, amount, 'the price of render job ' || job_id,
            'price:' || job_id || ':' || gen_random_uuid(),
            jsonb_build_object('job', job_id), current_user_id(), now() + interval '7 days')
    RETURNING id INTO oid;
    RETURN jsonb_build_object('order', oid, 'state', 'queued');
END
$$;

CREATE FUNCTION withdraw_price(job_id bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    o wallet_order := job_price(job_id);
BEGIN
    IF o.id IS null THEN
        RAISE EXCEPTION 'there is no price on that job' USING errcode = '23503';
    END IF;
    IF NOT holds(o.wallet_id) THEN
        RAISE EXCEPTION 'that price is not yours to withdraw' USING errcode = '42501';
    END IF;
    IF o.state <> 'held' THEN
        RAISE EXCEPTION 'the price is % — a moment', o.state USING errcode = '23514';
    END IF;
    UPDATE wallet_order SET state = 'releasing', said = 'Coming back.' WHERE id = o.id;
    RETURN jsonb_build_object('order', o.id, 'state', 'releasing');
END
$$;

GRANT EXECUTE ON FUNCTION set_price(bigint, numeric, uuid), withdraw_price(bigint)
TO player, admin;

-- The tile published: the price goes to the tab that did most of the work.
-- A renderer who holds no wallet (V5: unverified players render for free)
-- leaves it to come back to whoever set it.
CREATE OR REPLACE FUNCTION release_escrow(p_job bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    o     wallet_order := job_price(p_job);
    who   uuid;
    their uuid;
BEGIN
    IF o.id IS null OR o.state NOT IN ('queued', 'held') THEN
        RETURN;
    END IF;
    SELECT wk.user_id INTO who FROM atom a JOIN worker wk ON wk.id = a.worker_id
    WHERE a.job_id = p_job AND a.state IN ('verified', 'submitted')
    GROUP BY wk.user_id
    ORDER BY sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) DESC LIMIT 1;
    SELECT id INTO their FROM item WHERE held_by = who AND kind = 'wallet'
    ORDER BY created_at LIMIT 1;
    IF their IS null OR their = o.wallet_id THEN
        UPDATE wallet_order SET state = CASE WHEN state = 'held' THEN 'releasing'
                                             ELSE 'refused' END,
            said = 'The tile published; nobody with a wallet rendered it, so it'
                   || ' comes back.'
        WHERE id = o.id;
        RETURN;
    END IF;
    -- A price still leaving the owner's wallet is collected once it has left.
    UPDATE wallet_order SET other_id = their,
        state = CASE WHEN state = 'held' THEN 'confirmed' ELSE state END,
        said = 'The tile published: ' || player_name(who) || ' collects it.'
    WHERE id = o.id;
END
$$;

CREATE OR REPLACE FUNCTION refund_bounty(p_job bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    o wallet_order := job_price(p_job);
BEGIN
    IF o.id IS NOT null THEN
        UPDATE wallet_order SET state = CASE WHEN state = 'queued' THEN 'refused'
                                             ELSE 'releasing' END,
            said = 'The job was dropped, so it comes back.'
        WHERE id = o.id AND state IN ('queued', 'held');
    END IF;
    UPDATE job SET bounty = 0 WHERE id = p_job;
END
$$;

-- What the pool shows as a job's price is the cash held for it.
CREATE FUNCTION price_on_the_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.kind = 'hold' AND NEW.for_what ? 'job' THEN
        UPDATE job SET bounty = CASE WHEN NEW.state IN ('held', 'confirmed') THEN NEW.amount
                                     ELSE 0 END
        WHERE id = (NEW.for_what ->> 'job')::bigint;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER price_on_the_job BEFORE UPDATE OF state ON wallet_order
FOR EACH ROW EXECUTE FUNCTION price_on_the_job();

-- A price that was still leaving the wallet when the tile published is
-- collected as soon as it is held; one that was withdrawn while it was
-- leaving is given back as soon as it is held.
CREATE FUNCTION collect_when_held() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'hold' AND NEW.state = 'held' AND OLD.state = 'refused' THEN
        NEW.state := 'releasing';
    ELSIF NEW.kind = 'hold' AND NEW.state = 'held' AND NEW.other_id IS NOT null THEN
        NEW.state := 'confirmed';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER collect_when_held BEFORE UPDATE OF state ON wallet_order
FOR EACH ROW EXECUTE FUNCTION collect_when_held();

CREATE FUNCTION api.set_price(job_id bigint, amount numeric, w uuid DEFAULT null)
RETURNS jsonb LANGUAGE sql VOLATILE AS $$SELECT public.set_price(job_id, amount, w)$$;
CREATE FUNCTION api.withdraw_price(job_id bigint) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.withdraw_price(job_id)$$;
GRANT EXECUTE ON FUNCTION api.set_price(bigint, numeric, uuid),
    api.withdraw_price(bigint) TO player, admin;
