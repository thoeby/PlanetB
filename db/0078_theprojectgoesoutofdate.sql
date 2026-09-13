-- 0078_theprojectgoesoutofdate.sql — the QGIS project knows when it is old.
--
-- SPEC §3.10 step 2: "Owners see the 'QGIS project out of date' banner; the
-- next download has the dropdown". The project is generated from the world's
-- own vocabulary (server/splatworld/qgis.py, from `gis_layers()`), so a
-- property an admin adds this morning is a dropdown this afternoon — but only
-- for somebody who downloads the file again. Until now nothing told them to.
--
-- So the vocabulary carries a revision, bumped whenever a kind, a property or
-- a build rule changes, and each player's last download is remembered against
-- it. `project_state()` is then the whole banner: what the world is at, what
-- this player took, and whether the two agree.
--
-- The page records the download itself (`took_project`), because the file is
-- served by the file server and the file server decides nothing about the
-- world (Invariant 9). It is an ordinary client write under RLS (Invariant 6).

CREATE TABLE vocabulary_rev (
    one bigint PRIMARY KEY DEFAULT 1 CHECK (one = 1),
    rev bigint NOT NULL DEFAULT 1,
    at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vocabulary_rev (one) VALUES (1);

ALTER TABLE vocabulary_rev ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON vocabulary_rev FOR SELECT TO anon, player, admin
USING (true);
GRANT SELECT ON vocabulary_rev TO anon, player, admin;

-- SECURITY DEFINER: an admin editing the vocabulary holds no grant on this
-- table, and the revision is the database's own bookkeeping, not a client
-- write — the same reason `mark_tiles_dirty` is one (db/0004_tiles.sql).
CREATE FUNCTION bump_vocabulary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE vocabulary_rev SET rev = rev + 1, at = now() WHERE one = 1;
    RETURN NULL;
END
$$;

CREATE TRIGGER kind_vocabulary AFTER INSERT OR UPDATE OR DELETE ON kind
FOR EACH STATEMENT EXECUTE FUNCTION bump_vocabulary();
CREATE TRIGGER property_vocabulary AFTER INSERT OR UPDATE OR DELETE ON property
FOR EACH STATEMENT EXECUTE FUNCTION bump_vocabulary();
CREATE TRIGGER build_rule_vocabulary
AFTER INSERT OR UPDATE OR DELETE ON build_rule
FOR EACH STATEMENT EXECUTE FUNCTION bump_vocabulary();

-- What each player last downloaded. One row each: a second download replaces
-- the first, because what matters is whether the file on their disk is the
-- world's current vocabulary, not how many they have had.
CREATE TABLE project_take (
    user_id uuid PRIMARY KEY REFERENCES auth.user (id) ON DELETE CASCADE,
    rev     bigint NOT NULL,
    at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE project_take ENABLE ROW LEVEL SECURITY;
CREATE POLICY mine ON project_take FOR SELECT TO player, admin
USING (user_id = current_user_id());
GRANT SELECT ON project_take TO player, admin;

CREATE FUNCTION took_project() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    now_rev bigint;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT rev INTO now_rev FROM vocabulary_rev WHERE one = 1;
    INSERT INTO project_take (user_id, rev) VALUES (current_user_id(), now_rev)
    ON CONFLICT (user_id) DO UPDATE SET rev = excluded.rev, at = now();
    RETURN now_rev;
END
$$;

GRANT EXECUTE ON FUNCTION took_project() TO player, admin;

-- The banner, in one answer: `stale` is false for somebody who has never
-- downloaded one — there is nothing on their disk to be out of date, and the
-- Land panel already asks them to fetch it.
CREATE FUNCTION project_state() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT jsonb_build_object(
    'rev', v.rev,
    'took', t.rev,
    'at', t.at,
    'stale', t.rev IS NOT null AND t.rev < v.rev)
FROM vocabulary_rev v
LEFT JOIN project_take t ON t.user_id = current_user_id()
WHERE v.one = 1;
$$;

GRANT EXECUTE ON FUNCTION project_state() TO player, admin;

CREATE FUNCTION api.took_project() RETURNS bigint
LANGUAGE sql VOLATILE SET search_path = public AS $$SELECT public.took_project()$$;

CREATE FUNCTION api.project_state() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$SELECT public.project_state()$$;

GRANT EXECUTE ON FUNCTION api.took_project(), api.project_state()
TO player, admin;
