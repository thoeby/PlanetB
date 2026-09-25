-- 0214_hostingisaduty.sql — somebody's tab keeps a land's files for a term.
--
-- TASKS-live.md LV.13. A land's files live wherever a tab holds them (LV.12),
-- and a land nobody is looking at is held by nobody but the operator's node.
-- Its owner may pay for more: a `host` duty is the land's files — the CIDs its
-- published tiles and its things name, fixed when it is offered — for a term,
-- with a bounty. A player takes it with a tab; the tab fetches every one of
-- them, keeps them and serves them while it is open.
--
-- What is paid for is what was served. Every tab that got a file of the region
-- from the hosting tab says so under its own login (a receipt, written by the
-- fetching tab and nobody else — RLS, Invariant 6): one per player and file,
-- counted at the size the world knows the file to be, not the size anybody
-- says. After the term the host is paid the bounty in proportion to the
-- region's bytes it served, and the rest goes back.

CREATE TABLE host_receipt (
    duty_id    uuid NOT NULL REFERENCES duty (id) ON DELETE CASCADE,
    cid        text NOT NULL,
    player_id  uuid NOT NULL REFERENCES auth.user (id),
    bytes      bigint NOT NULL CHECK (bytes >= 0),
    at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (duty_id, cid, player_id)
);

ALTER TABLE host_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON host_receipt FOR SELECT USING (true);
GRANT SELECT ON host_receipt TO anon, player, admin;

-- The files a land's published tiles and placed things name, with a CID.
CREATE FUNCTION region_files(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
WITH land AS (SELECT geom FROM area WHERE id = p_area),
named AS (
    SELECT unnest(ARRAY[t.sog_sha256, t.manifest -> 'height' ->> 'sha256',
                        t.manifest -> 'colliders' ->> 'sha256',
                        t.manifest -> 'lod' ->> 'sha256']) AS sha256
    FROM tile t, land
    WHERE t.published_version > 0 AND st_intersects(tile_bbox(t.z, t.x, t.y), land.geom)
    UNION
    SELECT instance_sha(i.id) FROM instance i WHERE i.area_id = p_area
)
SELECT coalesce(jsonb_agg(jsonb_build_object('cid', a.cid, 'sha256', a.sha256,
    'bytes', a.bytes) ORDER BY a.sha256), '[]'::jsonb)
FROM (SELECT DISTINCT sha256 FROM named WHERE sha256 IS NOT NULL) n
JOIN artifact a ON a.sha256 = n.sha256
WHERE a.cid IS NOT NULL
$$;

GRANT EXECUTE ON FUNCTION region_files(uuid) TO anon, player, admin;

CREATE FUNCTION offer_host(p_area uuid, p_term interval, p_bounty numeric DEFAULT 0)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    files jsonb := region_files(p_area);
    id    uuid := gen_random_uuid();
BEGIN
    IF NOT is_area_proposer(p_area) THEN
        RAISE EXCEPTION 'You may only have your own land hosted.' USING errcode = '42501';
    END IF;
    IF jsonb_array_length(files) = 0 THEN
        RAISE EXCEPTION 'Nothing on that land has a file to host yet.' USING errcode = '22023';
    END IF;
    INSERT INTO duty (id, op, area_id, region, term, bounty, offered_by)
    VALUES (id, 'host', p_area, jsonb_build_object('files', files), p_term,
            coalesce(p_bounty, 0), current_user_id());
    -- Invariant 5: the bounty is in escrow from the offer to the settling.
    IF coalesce(p_bounty, 0) > 0 THEN
        PERFORM transfer(my_account(), escrow_account(), p_bounty, 'duty:' || id);
    END IF;
    RETURN id;
END
$$;

-- A tab takes it: the peer it hosts from is one of the player's own.
CREATE FUNCTION claim_host(p_duty uuid, p_peer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d duty%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM peer WHERE peer_id = p_peer
                   AND player_id = current_user_id()) THEN
        RAISE EXCEPTION 'That is not one of your tabs.' USING errcode = '42501';
    END IF;
    SELECT * INTO d FROM duty WHERE id = p_duty FOR UPDATE;
    IF d.id IS NULL OR d.op <> 'host' THEN
        RAISE EXCEPTION 'no such land to host' USING errcode = 'PT404';
    END IF;
    IF d.state <> 'open' THEN
        RAISE EXCEPTION 'Somebody is already hosting it.' USING errcode = 'PT409';
    END IF;
    UPDATE duty SET state = 'claimed', claimed_by = current_user_id(), claimed_at = now(),
        ends_at = now() + term, region = region || jsonb_build_object('peer', p_peer)
    WHERE id = p_duty RETURNING * INTO d;
    RETURN jsonb_build_object('duty', d.id, 'files', d.region -> 'files',
        'ends_at', d.ends_at, 'term_s', extract(epoch FROM d.term)::int);
END
$$;

-- The fetching tab says it got a file of a hosted region from the hosting
-- tab. Nothing when that tab hosts nothing with that file, or is the
-- player's own; the bytes are the world's, not the caller's.
CREATE FUNCTION host_served(p_peer text, p_cid text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d     duty%ROWTYPE;
    bytes bigint;
BEGIN
    IF current_user_id() IS NULL THEN
        RETURN false;
    END IF;
    SELECT * INTO d FROM duty
    WHERE op = 'host' AND state = 'claimed' AND ends_at > now()
      AND region ->> 'peer' = p_peer AND claimed_by <> current_user_id()
      AND region -> 'files' @> jsonb_build_array(jsonb_build_object('cid', p_cid))
    ORDER BY claimed_at LIMIT 1;
    IF d.id IS NULL THEN
        RETURN false;
    END IF;
    SELECT (f ->> 'bytes')::bigint INTO bytes
    FROM jsonb_array_elements(d.region -> 'files') f WHERE f ->> 'cid' = p_cid LIMIT 1;
    INSERT INTO host_receipt (duty_id, cid, player_id, bytes)
    VALUES (d.id, p_cid, current_user_id(), bytes) ON CONFLICT DO NOTHING;
    RETURN FOUND;
END
$$;

-- What a host duty earned: the share of the region's bytes it served, each
-- file counted once per player who got it, never more than the whole bounty.
CREATE FUNCTION host_share(d duty) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT least(1, coalesce((SELECT sum(r.bytes) FROM host_receipt r WHERE r.duty_id = d.id), 0)
    / greatest(1, (SELECT sum((f ->> 'bytes')::numeric)
                   FROM jsonb_array_elements(d.region -> 'files') f)))
$$;

-- Settling a host duty: the served share to the host, the rest back. A flow
-- duty settles as it did (db/0211).
CREATE OR REPLACE FUNCTION settle_duty(p_duty uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d      duty%ROWTYPE;
    total  int;
    share  record;
    earned numeric;
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
    IF d.op = 'host' THEN
        earned := CASE WHEN d.state = 'claimed' THEN round(d.bounty * host_share(d), 6) ELSE 0 END;
        total := (SELECT count(*) FROM host_receipt WHERE duty_id = d.id);
        IF earned > 0 THEN
            PERFORM transfer(escrow_account(), (SELECT id FROM account
                WHERE owner_id = d.claimed_by), earned, 'duty:' || d.id || ':' || d.claimed_by);
        END IF;
        IF d.bounty - earned > 0 THEN
            PERFORM transfer(escrow_account(), (SELECT id FROM account
                WHERE owner_id = d.offered_by), d.bounty - earned, 'duty:' || d.id || ':back');
        END IF;
    ELSE
        total := jsonb_array_length(d.result);
        IF d.bounty > 0 AND total > 0 THEN
            FOR share IN SELECT (r ->> 'by')::uuid AS who, count(*) AS n
                         FROM jsonb_array_elements(d.result) r GROUP BY 1 LOOP
                PERFORM transfer(escrow_account(),
                    (SELECT id FROM account WHERE owner_id = share.who),
                    round(d.bounty * share.n / total, 6), 'duty:' || d.id || ':' || share.who);
            END LOOP;
        ELSIF d.bounty > 0 THEN
            PERFORM transfer(escrow_account(), (SELECT id FROM account
                WHERE owner_id = d.offered_by), d.bounty, 'duty:' || d.id || ':back');
        END IF;
    END IF;
    UPDATE duty SET state = CASE WHEN d.state = 'open' THEN 'cancelled' ELSE 'done' END,
                    settled_at = now()
    WHERE id = p_duty RETURNING * INTO d;
    RETURN jsonb_build_object('state', d.state, 'settled_at', d.settled_at, 'runs', total,
        'paid', earned);
END
$$;

GRANT EXECUTE ON FUNCTION offer_host(uuid, interval, numeric), claim_host(uuid, text),
    host_served(text, text) TO player, admin;
GRANT EXECUTE ON FUNCTION host_share(duty) TO anon, player, admin;

-- The pool as the page reads it, with what a host duty holds and has served.
CREATE OR REPLACE VIEW api.duty WITH (security_invoker = true) AS
SELECT d.id, d.op, d.area_id, coalesce(a.rules ->> 'name', 'a land') AS land,
    d.flow_id, public.duty_flow_name(d) AS flow_name,
    d.elx_sha256, d.instance_id, d.needs, d.region, d.term, d.bounty, d.state,
    d.offered_by, player_name(d.offered_by) AS offered_by_name, d.created_at,
    d.claimed_by, player_name(d.claimed_by) AS claimed_by_name, d.claimed_at, d.ends_at,
    jsonb_array_length(d.result) AS runs, d.settled_at, may_claim_duty(d) AS may_claim,
    jsonb_array_length(coalesce(d.region -> 'files', '[]')) AS files,
    (SELECT count(*) FROM public.host_receipt r WHERE r.duty_id = d.id)::int AS served,
    host_share(d) AS share
FROM public.duty d LEFT JOIN public.area a ON a.id = d.area_id;

CREATE FUNCTION api.offer_host(area uuid, term interval, bounty numeric DEFAULT 0) RETURNS uuid
LANGUAGE sql VOLATILE AS $$SELECT public.offer_host(area, term, bounty)$$;
CREATE FUNCTION api.claim_host(duty uuid, peer text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.claim_host(duty, peer)$$;
CREATE FUNCTION api.host_served(peer text, cid text) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.host_served(peer, cid)$$;
CREATE FUNCTION api.region_files(area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.region_files(area)$$;
GRANT EXECUTE ON FUNCTION api.offer_host(uuid, interval, numeric), api.claim_host(uuid, text),
    api.host_served(text, text) TO player, admin;
GRANT EXECUTE ON FUNCTION api.region_files(uuid) TO anon, player, admin;
