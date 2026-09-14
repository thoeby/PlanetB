-- 0093_afailedpiecegoesbackatonce.sql — a piece a tab could not do goes back
-- into the pool the moment the tab knows, not five minutes later.
--
-- A tab that claimed an atom and hit an error — the elevation service not
-- answering, an asset the store had lost, a shader that would not compile —
-- logged the error, threw, and left the atom `claimed`. Nothing in the world
-- knew the work had stopped: the pool said "1 piece(s) are in somebody else's
-- hands" (the person's own, as it happened) until expire_claims gave up on the
-- heartbeat — five minutes, thirty for a train — and only when somebody next
-- claimed anything at all. Pressing Render on the tile claimed nothing, said
-- so a minute later, and the piece was still in those hands.
--
-- `fail_atom` is the tab saying "this attempt failed" itself. It is the same
-- transition expire_claims makes — an attempt counted, the third one final,
-- the piece back to `ready` for anybody — with the reason recorded on the
-- atom, immediately. Only the holder may say it (Invariant 6: the row says
-- whose hands it is in).
CREATE FUNCTION fail_atom(p_atom bigint, p_reason text DEFAULT '') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a atom%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.state <> 'claimed' THEN
        RETURN coalesce(a.state, 'missing');
    END IF;
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM worker w
                       WHERE w.id = a.worker_id AND w.user_id = current_user_id()) THEN
        RAISE EXCEPTION 'that piece is not in your hands' USING errcode = '42501';
    END IF;
    UPDATE atom
    SET attempts = a.attempts + 1,
        state = CASE WHEN a.attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        worker_id = null, claimed_at = null, heartbeat_at = null,
        result = jsonb_build_object('error', left(coalesce(p_reason, ''), 600),
                                    'attempt', a.attempts + 1)
    WHERE id = p_atom RETURNING * INTO a;
    RETURN a.state;
END
$$;

GRANT EXECUTE ON FUNCTION fail_atom(bigint, text) TO player, admin;

CREATE FUNCTION api.fail_atom(atom_id bigint, reason text DEFAULT '') RETURNS text
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.fail_atom(atom_id, reason);
$$;

GRANT EXECUTE ON FUNCTION api.fail_atom(bigint, text) TO player, admin;
