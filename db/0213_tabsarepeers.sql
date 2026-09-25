-- 0213_tabsarepeers.sql — every open tab is a peer, and says what it holds.
--
-- TASKS-live.md LV.12. A tab runs a libp2p node of its own (client/js/
-- peers.js), reached through the operator's relay (tools/node.mjs). It keeps
-- what it fetched and serves it while it is open. For another tab to ask it,
-- the world has to know it is there and what it has: the tab says its peer
-- id, the addresses it can be dialled on and the CIDs it holds, and says it
-- again as that changes; closing the tab takes it away. A tab not heard from
-- for two minutes is gone whether it said so or not.
--
-- The world only lists; it dials nobody and fetches nothing (Invariant 9).

CREATE TABLE peer (
    peer_id   text PRIMARY KEY CHECK (peer_id ~ '^[1-9A-HJ-NP-Za-km-z]{40,64}$'),
    player_id uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    addrs     text [] NOT NULL DEFAULT '{}',
    cids      text [] NOT NULL DEFAULT '{}',
    lon       double precision,
    lat       double precision,
    seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX peer_cids_idx ON peer USING gin (cids);
CREATE INDEX peer_seen_idx ON peer (seen_at);

-- Who is out there is the world's to read; writing is the two functions below.
ALTER TABLE peer ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON peer FOR SELECT USING (true);
GRANT SELECT ON peer TO anon, player, admin;

CREATE FUNCTION register_peer(p_peer_id text, p_addrs text [], p_cids text [],
                              p_lon double precision DEFAULT NULL,
                              p_lat double precision DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM peer WHERE peer_id = p_peer_id
               AND player_id <> current_user_id()) THEN
        RAISE EXCEPTION 'that peer is somebody else''s tab' USING errcode = '42501';
    END IF;
    INSERT INTO peer (peer_id, player_id, addrs, cids, lon, lat)
    VALUES (p_peer_id, current_user_id(), coalesce(p_addrs, '{}'),
            coalesce(p_cids[1:2000], '{}'), p_lon, p_lat)
    ON CONFLICT (peer_id) DO UPDATE
    SET addrs = excluded.addrs, cids = excluded.cids, lon = excluded.lon,
        lat = excluded.lat, seen_at = now();
    -- Tabs that stopped saying anything are forgotten on the way.
    DELETE FROM peer WHERE seen_at < now() - interval '10 minutes';
    RETURN coalesce(array_length(p_cids, 1), 0);
END
$$;

CREATE FUNCTION unregister_peer(p_peer_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM peer WHERE peer_id = p_peer_id AND player_id = current_user_id();
    RETURN FOUND;
END
$$;

-- The tabs that hold a file now, newest first; the asker leaves itself out.
CREATE FUNCTION peers_for(p_cid text, p_not text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object('peer_id', p.peer_id, 'addrs', p.addrs,
    'player', player_name(p.player_id)) ORDER BY p.seen_at DESC), '[]'::jsonb)
FROM peer p
WHERE p.cids @> ARRAY[p_cid] AND p.seen_at > now() - interval '2 minutes'
  AND p.peer_id IS DISTINCT FROM p_not
$$;

GRANT EXECUTE ON FUNCTION register_peer(text, text [], text [], double precision,
    double precision), unregister_peer(text) TO player, admin;
GRANT EXECUTE ON FUNCTION peers_for(text, text) TO anon, player, admin;

-- A published tile's sog, by CID as well as by sha256: what the streamer asks
-- peers for (the view's * was expanded before the column existed).
CREATE OR REPLACE VIEW api.tile WITH (security_invoker = true) AS
SELECT t.*, (SELECT a.cid FROM public.artifact a WHERE a.sha256 = t.sog_sha256) AS sog_cid
FROM public.tile t;

CREATE VIEW api.peer WITH (security_invoker = true) AS SELECT * FROM public.peer;
GRANT SELECT ON api.peer TO anon, player, admin;

CREATE FUNCTION api.register_peer(peer_id text, addrs text [], cids text [],
                                  lon double precision DEFAULT NULL,
                                  lat double precision DEFAULT NULL) RETURNS int
LANGUAGE sql VOLATILE AS $$SELECT public.register_peer(peer_id, addrs, cids, lon, lat)$$;
CREATE FUNCTION api.unregister_peer(peer_id text) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.unregister_peer(peer_id)$$;
CREATE FUNCTION api.peers_for(cid text, not_peer text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.peers_for(cid, not_peer)$$;
GRANT EXECUTE ON FUNCTION api.register_peer(text, text [], text [], double precision,
    double precision), api.unregister_peer(text) TO player, admin;
GRANT EXECUTE ON FUNCTION api.peers_for(text, text) TO anon, player, admin;
