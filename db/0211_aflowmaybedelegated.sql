-- 0211_aflowmaybedelegated.sql — somebody else's process server may run a
-- land's flow, for a term, under a key that reaches no further.
--
-- TASKS-live.md LV.10. A flow runs on a process server (Invariant 9: the
-- world runs nothing). Until now it was the land's own player's server;
-- here a player without one offers the flow to the pool, and a player who has
-- one takes it, like a render:
--
--   offer_flow(flow, term, bounty)  the ELX by hash, a term, a bounty in escrow
--   claim_duty(duty, server)        -> a key scoped to that land, those needs,
--                                      that term; the claimant's own tab puts
--                                      the ELX on their server for the term
--   duty_receipt(duty, receipt)     one per run, into `result`
--   settle_duty(duty)               after the term: the bounty, pro rata by
--                                   receipts, like renders (db/0129)
--
-- A render is a tile at a version (job) in pieces (atom); a delegated flow is
-- neither, so it is a table of its own, `duty`, which LV.13's hosting shares.
-- Jobs whose flow needs `pay` are not offered to strangers: only somebody who
-- may build on the land may claim one.

CREATE TABLE duty (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    op          text NOT NULL CHECK (op IN ('flow', 'host')),
    area_id     uuid REFERENCES area (id) ON DELETE CASCADE,
    flow_id     uuid REFERENCES flow (id) ON DELETE CASCADE,
    elx_sha256  text REFERENCES artifact (sha256),
    instance_id uuid REFERENCES instance (id) ON DELETE SET NULL,
    needs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    region      jsonb,
    term        interval NOT NULL CHECK (term BETWEEN interval '10 seconds' AND interval '30 days'),
    bounty      numeric(18, 6) NOT NULL DEFAULT 0 CHECK (bounty >= 0),
    state       text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'claimed', 'done', 'cancelled')),
    offered_by  uuid NOT NULL REFERENCES auth.user (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    claimed_by  uuid REFERENCES auth.user (id),
    server_id   uuid REFERENCES process_server (id),
    key_jti     uuid UNIQUE,
    claimed_at  timestamptz,
    ends_at     timestamptz,
    result      jsonb NOT NULL DEFAULT '[]'::jsonb,
    settled_at  timestamptz,
    CHECK ((op = 'flow') = (elx_sha256 IS NOT NULL))
);
CREATE INDEX duty_open_idx ON duty (op, state) WHERE state IN ('open', 'claimed');

-- The pool is public to read, as the render pool is: what is on offer, for
-- how long and for how much. Nobody writes it but the functions below.
ALTER TABLE duty ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON duty FOR SELECT USING (true);
GRANT SELECT ON duty TO anon, player, admin;

-- ------------------------------------------------------------------ offer

CREATE FUNCTION offer_flow(p_flow uuid, p_term interval, p_bounty numeric DEFAULT 0)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    f     flow%ROWTYPE;
    needs jsonb;
    id    uuid := gen_random_uuid();
BEGIN
    SELECT * INTO f FROM flow WHERE flow.id = p_flow AND deleted_at IS NULL;
    IF f.id IS NULL OR NOT is_area_proposer(f.area_id) THEN
        RAISE EXCEPTION 'You may not hand out the flows of that land.' USING errcode = '42501';
    END IF;
    -- A thing's flow needs what its owner consented to (db/0210); a land's
    -- own flow reaches the land's ports and nothing else.
    needs := coalesce((SELECT i.consent -> 'needs' FROM instance i WHERE i.id = f.instance_id),
                      '{"ports": "area"}'::jsonb);
    INSERT INTO duty (id, op, area_id, flow_id, elx_sha256, instance_id, needs, term,
                      bounty, offered_by)
    VALUES (id, 'flow', f.area_id, f.id, f.elx_sha256, f.instance_id, needs, p_term,
            coalesce(p_bounty, 0), current_user_id());
    IF coalesce(p_bounty, 0) > 0 THEN
        PERFORM transfer(my_account(), escrow_account(), p_bounty, 'duty:' || id);
    END IF;
    RETURN id;
END
$$;

-- ------------------------------------------------------------------ claim

-- Whether somebody may take a duty: anybody, unless its flow may pay, which
-- only somebody who builds on the land may run.
CREATE FUNCTION may_claim_duty(d duty) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT d.state = 'open' AND (NOT d.needs ? 'pay' OR is_area_proposer(d.area_id))
$$;

CREATE FUNCTION claim_duty(p_duty uuid, p_server uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    d   duty%ROWTYPE;
    jti uuid := gen_random_uuid();
BEGIN
    IF NOT EXISTS (SELECT 1 FROM process_server s WHERE s.id = p_server
                   AND s.owner_id = current_user_id() AND s.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'That is not one of your servers.' USING errcode = '42501';
    END IF;
    SELECT * INTO d FROM duty WHERE id = p_duty FOR UPDATE;
    IF d.id IS NULL OR d.op <> 'flow' THEN
        RAISE EXCEPTION 'no such flow to run' USING errcode = 'PT404';
    END IF;
    IF d.state <> 'open' THEN
        RAISE EXCEPTION 'Somebody is already running it.' USING errcode = 'PT409';
    END IF;
    IF NOT may_claim_duty(d) THEN
        RAISE EXCEPTION 'This flow may pay, so only somebody who builds on its land runs it.'
            USING errcode = '42501';
    END IF;
    UPDATE duty SET state = 'claimed', claimed_by = current_user_id(), server_id = p_server,
        key_jti = jti, claimed_at = now(), ends_at = now() + term
    WHERE id = p_duty RETURNING * INTO d;
    RETURN jsonb_build_object('duty', d.id, 'elx_sha256', d.elx_sha256,
        'ends_at', d.ends_at, 'term_s', extract(epoch FROM d.term)::int,
        'key', auth.sign(json_build_object('role', 'flow', 'sub', d.offered_by,
            'duty', d.id, 'area', d.area_id, 'jti', jti, 'needs', d.needs,
            'exp', extract(epoch FROM d.ends_at)::bigint)));
END
$$;

GRANT EXECUTE ON FUNCTION offer_flow(uuid, interval, numeric), claim_duty(uuid, uuid)
TO player, admin;
GRANT EXECUTE ON FUNCTION may_claim_duty(duty) TO anon, player, admin;

-- ------------------------------------------------------------ the key

-- db/0198's flow_key_reaches, with a delegated flow's key beside a deployed
-- one's: the duty is claimed under that key, its term has not run out, and it
-- is about this land.
CREATE OR REPLACE FUNCTION flow_key_reaches(p_area uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT current_user_role() = 'flow' AND is_area_proposer(p_area) AND (
    EXISTS (SELECT 1 FROM flow_deployment d JOIN flow f ON f.id = d.flow_id
            WHERE d.key_jti::text = flow_claim('jti')
              AND f.id::text = flow_claim('flow')
              AND d.revoked_at IS NULL AND f.deleted_at IS NULL
              AND f.area_id = p_area)
    OR EXISTS (SELECT 1 FROM duty d
               WHERE d.id::text = flow_claim('duty') AND d.key_jti::text = flow_claim('jti')
                 AND d.state = 'claimed' AND d.ends_at > now() AND d.area_id = p_area));
$$;

-- A delegated flow that needs only its own thing's ports reaches that thing.
CREATE FUNCTION duty_reaches_thing(p_instance uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT flow_claim('duty') IS NULL OR EXISTS (
    SELECT 1 FROM duty d WHERE d.id::text = flow_claim('duty')
      AND (d.needs ->> 'ports' IS DISTINCT FROM 'own' OR d.instance_id = p_instance))
$$;

-- db/0198's may_write_port, held to the duty's own thing where it says so.
CREATE OR REPLACE FUNCTION may_write_port(p_instance uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM instance i
               WHERE i.id = p_instance AND i.deleted_at IS null
                 AND CASE WHEN current_user_role() = 'flow'
                          THEN public.flow_key_reaches(i.area_id)
                               AND public.duty_reaches_thing(i.id)
                          ELSE public.is_area_proposer(i.area_id) END);
$$;

GRANT EXECUTE ON FUNCTION duty_reaches_thing(uuid) TO flow, player, admin;

-- ------------------------------------------------------- receipts and pay

-- One run, said by whoever claimed it, from their own server's report.
CREATE FUNCTION duty_receipt(p_duty uuid, p_receipt jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int;
BEGIN
    UPDATE duty SET result = result || jsonb_build_array(jsonb_build_object(
        'by', current_user_id(), 'at', now(), 'receipt', p_receipt))
    WHERE id = p_duty AND claimed_by = current_user_id() AND state = 'claimed'
    RETURNING jsonb_array_length(result) INTO n;
    IF n IS NULL THEN
        RAISE EXCEPTION 'That is not a flow you are running.' USING errcode = '42501';
    END IF;
    RETURN n;
END
$$;

-- After the term: the bounty to whoever ran it, pro rata by receipts, and
-- back to whoever offered it when nobody did. Anybody may say the term is
-- over; the clock decides whether it is.
CREATE FUNCTION settle_duty(p_duty uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d     duty%ROWTYPE;
    total int;
    share record;
BEGIN
    SELECT * INTO d FROM duty WHERE id = p_duty FOR UPDATE;
    IF d.id IS NULL THEN
        RAISE EXCEPTION 'no such duty' USING errcode = 'PT404';
    END IF;
    IF d.state IN ('done', 'cancelled') THEN
        RETURN jsonb_build_object('state', d.state, 'settled_at', d.settled_at);
    END IF;
    IF d.state = 'claimed' AND d.ends_at > now() THEN
        RAISE EXCEPTION 'Its term runs until %.', d.ends_at USING errcode = '23514';
    END IF;
    IF d.state = 'open' AND d.offered_by IS DISTINCT FROM current_user_id() THEN
        RAISE EXCEPTION 'Only who offered it takes it back.' USING errcode = '42501';
    END IF;
    total := jsonb_array_length(d.result);
    IF d.bounty > 0 AND total > 0 THEN
        FOR share IN SELECT (r ->> 'by')::uuid AS who, count(*) AS n
                     FROM jsonb_array_elements(d.result) r GROUP BY 1 LOOP
            PERFORM transfer(escrow_account(),
                (SELECT id FROM account WHERE owner_id = share.who),
                round(d.bounty * share.n / total, 6), 'duty:' || d.id || ':' || share.who);
        END LOOP;
    ELSIF d.bounty > 0 THEN
        PERFORM transfer(escrow_account(), (SELECT id FROM account WHERE owner_id = d.offered_by),
            d.bounty, 'duty:' || d.id || ':back');
    END IF;
    UPDATE duty SET state = CASE WHEN d.state = 'open' THEN 'cancelled' ELSE 'done' END,
                    settled_at = now()
    WHERE id = p_duty RETURNING * INTO d;
    RETURN jsonb_build_object('state', d.state, 'settled_at', d.settled_at, 'runs', total);
END
$$;

GRANT EXECUTE ON FUNCTION duty_receipt(uuid, jsonb), settle_duty(uuid) TO player, admin;

-- ------------------------------------------------------------------ the api

-- The offered flow's name, for whoever may take it: the flow itself is its
-- land's to read (RLS), its name is part of the offer.
CREATE FUNCTION duty_flow_name(d duty) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT f.name FROM flow f WHERE f.id = d.flow_id
$$;
GRANT EXECUTE ON FUNCTION duty_flow_name(duty) TO anon, player, admin;


CREATE VIEW api.duty WITH (security_invoker = true) AS
SELECT d.id, d.op, d.area_id, coalesce(a.rules ->> 'name', 'a land') AS land,
    d.flow_id, public.duty_flow_name(d) AS flow_name,
    d.elx_sha256, d.instance_id, d.needs, d.region, d.term, d.bounty, d.state,
    d.offered_by, player_name(d.offered_by) AS offered_by_name, d.created_at,
    d.claimed_by, player_name(d.claimed_by) AS claimed_by_name, d.claimed_at, d.ends_at,
    jsonb_array_length(d.result) AS runs, d.settled_at, may_claim_duty(d) AS may_claim
FROM public.duty d LEFT JOIN public.area a ON a.id = d.area_id;
GRANT SELECT ON api.duty TO anon, player, admin;

CREATE FUNCTION api.offer_flow(flow uuid, term interval, bounty numeric DEFAULT 0) RETURNS uuid
LANGUAGE sql VOLATILE AS $$SELECT public.offer_flow(flow, term, bounty)$$;
CREATE FUNCTION api.claim_duty(duty uuid, server uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.claim_duty(duty, server)$$;
CREATE FUNCTION api.duty_receipt(duty uuid, receipt jsonb) RETURNS int
LANGUAGE sql VOLATILE AS $$SELECT public.duty_receipt(duty, receipt)$$;
CREATE FUNCTION api.settle_duty(duty uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.settle_duty(duty)$$;
GRANT EXECUTE ON FUNCTION api.offer_flow(uuid, interval, numeric), api.claim_duty(uuid, uuid),
    api.duty_receipt(uuid, jsonb), api.settle_duty(uuid) TO player, admin;
