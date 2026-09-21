-- 0180_anartifactthestorehaslost.sql — an artifact the database knows and
-- the store has lost can be made again.
--
-- What was seen: "artifact 9d47… is registered but is nowhere in the store",
-- and none of Use this ground, Cut the ground again, Render the whole ground
-- again or Draw every frame again got past it. Each of those reopens the work
-- through ensure_job, and new_atom reuses a verified atom by its atom_hash
-- (Invariant 2) — so the assemble whose output file was gone stayed verified,
-- the frames that read it got a 404, and a tab that ran the same assemble
-- again computed the same bytes and was refused the upload, because can_write
-- refuses a sha the artifact table already holds (Invariant 1). Nothing on
-- the page could get the bytes back into the store, and nothing on the page
-- could say so.
--
-- The world cannot see the store (Invariant 9: the server checks nothing and
-- computes nothing), so it takes a tab's word for it — but only a tab that
-- holds a claim on an atom that makes or reads the artifact, or an admin, and
-- what the word costs is one recomputation of the thing the tab is already
-- holding. `artifact_missing` forgets the row, and every atom whose output it
-- was goes back to the start by legal steps (verified -> failed -> ready or
-- waiting, db/0005_state.sql). Its dependants are left as they are: an atom
-- that read the bytes before they were lost read the same bytes, and a
-- deterministic re-run lands them at the same address again.
--
-- An artifact that a tile publishes, a ground layer holds, or a product's
-- thumbnail is cannot be forgotten this way: its foreign key says so, and the
-- error says which.
CREATE FUNCTION artifact_missing(p_sha text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    n   int := 0;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a sha256 is needed' USING errcode = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact WHERE sha256 = p_sha) THEN
        RETURN 0;
    END IF;
    SELECT id INTO wid FROM worker WHERE user_id = current_user_id() ORDER BY id LIMIT 1;
    IF current_user_role() <> 'admin' AND NOT EXISTS (
        SELECT 1 FROM atom a
        WHERE a.state = 'claimed' AND a.worker_id = wid
          AND (a.output_sha256 = p_sha
               OR a.inputs::text LIKE '%' || p_sha || '%'
               OR EXISTS (SELECT 1 FROM atom d
                          WHERE d.output_sha256 = p_sha
                            AND a.inputs::text ~ ('[^0-9]' || d.id || '[^0-9]')))) THEN
        RAISE EXCEPTION 'only a tab that is holding work that makes or reads % may say'
            ' it is missing', p_sha USING errcode = '42501';
    END IF;

    -- The tile remembers why (db/0143), before the rows forget the sha.
    PERFORM note_tile_event(a, 'handed_back',
        'its ' || a.op || ' output was gone from the store; it is made again')
    FROM atom a WHERE a.output_sha256 = p_sha;
    -- Back to the start, by legal steps. Every state may go to failed, and
    -- failed to ready or waiting (db/0005_state.sql).
    UPDATE atom SET state = 'failed', worker_id = null, claimed_at = null,
        heartbeat_at = null
    WHERE output_sha256 = p_sha AND state <> 'failed';
    UPDATE atom SET state = CASE WHEN cardinality(deps) = 0 THEN 'ready' ELSE 'waiting' END,
        attempts = 0, handed_back = 0, output_sha256 = null, result = null
    WHERE output_sha256 = p_sha;
    GET DIAGNOSTICS n = ROW_COUNT;
    BEGIN
        DELETE FROM artifact WHERE sha256 = p_sha;
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'artifact % is still published or held somewhere: %', p_sha,
            SQLERRM USING errcode = '23503';
    END;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION artifact_missing(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION artifact_missing(text) TO player, admin;

CREATE FUNCTION api.artifact_missing(sha256 text) RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.artifact_missing(sha256);
$$;

GRANT EXECUTE ON FUNCTION api.artifact_missing(text) TO player, admin;
