-- 0212_everyartifacthasacid.sql — every file the world holds has an IPFS CID
-- beside its sha256.
--
-- TASKS-live.md LV.11. sha256 stays the identity (Invariant 1). The CID is how
-- a file is found among peers that are not this server — other players' tabs
-- (LV.12), and the operator's own node, tools/node.mjs — and it is derived
-- with fixed settings so anybody can recompute it from the bytes:
--
--   UnixFS, CIDv1, raw leaves, 256 KiB chunks, balanced, 174 links a node
--
-- (server/splatworld/cid.py computes it without the node; tools/files-test.sh
-- holds the two to the same answer.) The file store records it after a PUT
-- has passed can_write and the node has the bytes; the file may arrive before
-- its artifact row does, so the CID waits in `file_cid` until it does.

ALTER TABLE artifact ADD COLUMN cid text CHECK (cid IS NULL OR cid ~ '^b[a-z2-7]{20,}$');
CREATE INDEX artifact_cid_idx ON artifact (cid);

CREATE TABLE file_cid (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    cid    text NOT NULL CHECK (cid ~ '^b[a-z2-7]{20,}$'),
    at     timestamptz NOT NULL DEFAULT now()
);

-- The world is public to read: a CID says where to ask for bytes the world
-- already says exist.
ALTER TABLE file_cid ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON file_cid FOR SELECT USING (true);
GRANT SELECT ON file_cid TO anon, player, admin;

-- The store says it: an admin login (the files server's and the node's own),
-- after the bytes passed can_write. Idempotent, and a sha256 is never given a
-- second, different CID — the settings are fixed, so a different answer is a
-- broken importer, and that is refused rather than recorded.
CREATE FUNCTION record_cid(p_sha256 text, p_cid text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    had text;
BEGIN
    IF current_user_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'only the file store records a CID' USING errcode = '42501';
    END IF;
    SELECT cid INTO had FROM file_cid WHERE sha256 = p_sha256;
    IF had IS NOT NULL AND had <> p_cid THEN
        RAISE EXCEPTION '% already has CID %, not %', p_sha256, had, p_cid
            USING errcode = '23505';
    END IF;
    INSERT INTO file_cid (sha256, cid) VALUES (p_sha256, p_cid) ON CONFLICT DO NOTHING;
    UPDATE artifact SET cid = p_cid WHERE sha256 = p_sha256 AND cid IS NULL;
    RETURN p_cid;
END
$$;

GRANT EXECUTE ON FUNCTION record_cid(text, text) TO admin;

-- An artifact registered after its bytes were added takes the CID then.
CREATE FUNCTION artifact_takes_cid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    new.cid := coalesce(new.cid, (SELECT cid FROM file_cid WHERE sha256 = new.sha256));
    RETURN new;
END
$$;
CREATE TRIGGER artifact_takes_cid BEFORE INSERT ON artifact
FOR EACH ROW EXECUTE FUNCTION artifact_takes_cid();

-- The CID of a file by its sha256, and the other way round: what the page and
-- the old /tiles and /assets paths (LV.14) ask.
CREATE FUNCTION cid_of(p_sha256 text) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce((SELECT cid FROM artifact WHERE sha256 = p_sha256),
                (SELECT cid FROM file_cid WHERE sha256 = p_sha256))
$$;

GRANT EXECUTE ON FUNCTION cid_of(text) TO anon, player, admin;

CREATE OR REPLACE VIEW api.artifact WITH (security_invoker = true)
AS SELECT * FROM public.artifact;
CREATE FUNCTION api.record_cid(sha256 text, cid text) RETURNS text
LANGUAGE sql VOLATILE AS $$SELECT public.record_cid(sha256, cid)$$;
CREATE FUNCTION api.cid_of(sha256 text) RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.cid_of(sha256)$$;
GRANT EXECUTE ON FUNCTION api.record_cid(text, text) TO admin;
GRANT EXECUTE ON FUNCTION api.cid_of(text) TO anon, player, admin;
