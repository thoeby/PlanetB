-- 0166_anartifactknowswhereitis.sql — an artifact says where its bytes are,
-- and a tab is offered only the atoms it can build.
--
-- Two rough edges of the job management, both found by the same tile:
--
-- 1. `artifact` said a file existed and nothing said where. can_write refuses
--    a registered sha (Invariant 1), and client/js/work.js `elsewhere` then
--    guessed the address from the atoms that named the sha as their output.
--    drop_job (db/0150) deletes a job's atoms; the file stays under
--    /jobs/<old atom>/ and the row that could reconstruct that path is gone.
--    Assemble is deterministic, so the next compile of the same tile makes
--    the same bytes, is refused, and finds nothing: "registered but nowhere
--    in the store". The row knows now. register_artifact takes the path the
--    bytes were written to, fills it where it is null and never moves it: an
--    artifact is written once, so its first address is its address.
--
-- 2. claim_atom handed a tab atoms of a version its code does not build. The
--    tab refused them (work.js `compute`, Invariant 2) and each refusal cost
--    the atom an attempt: three tabs on new code and the piece was `failed`
--    for a reason that was nobody's. The tab has always sent what it builds
--    (probeCaps `algo`), and atom_fits reads it now.

ALTER TABLE artifact ADD COLUMN path text;

-- What is already known, from where the atoms said they put things: every
-- file an atom delivered is in its result (work.js `deliver`), and the kinds
-- with one address each are named by ARCHITECTURE §7.
UPDATE artifact a
SET path = f ->> 'path'
FROM atom, jsonb_array_elements(atom.result -> 'files') AS f
WHERE a.path IS NULL AND f ->> 'sha' = a.sha256 AND f ->> 'path' IS NOT NULL;
UPDATE artifact SET path = '/assets/' || sha256 || '.glb' WHERE path IS NULL AND kind = 'glb';
UPDATE artifact SET path = '/assets/' || sha256 || '.webp' WHERE path IS NULL AND kind = 'thumb';
UPDATE artifact
SET path = '/assets/' || sha256 || '.r32' WHERE path IS NULL AND kind = 'height_edit';

-- One function, one signature: PostgREST cannot pick between overloads, so
-- the four-argument one is dropped rather than kept beside the new one.
-- Every caller that passed four still may.
DROP FUNCTION api.register_artifact(text, text, bigint, text);
DROP FUNCTION register_artifact(text, text, bigint, text);

CREATE FUNCTION register_artifact(sha256 text, kind text, bytes bigint,
                                  algo_version text, path text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    p_sha  text := register_artifact.sha256;
    p_kind text := register_artifact.kind;
    p_len  bigint := register_artifact.bytes;
    p_algo text := register_artifact.algo_version;
    p_path text := register_artifact.path;
BEGIN
    -- Invariant 1: an artifact is written once and never replaced, and so is
    -- its address. A second registration may tell a row that had no path
    -- where the bytes are; it may not move them.
    INSERT INTO artifact (sha256, kind, bytes, algo_version, created_by, path)
    VALUES (p_sha, p_kind, p_len, p_algo, current_user_id(), p_path)
    ON CONFLICT (sha256) DO UPDATE SET path = coalesce(artifact.path, excluded.path);
    RETURN p_sha;
END
$$;
GRANT EXECUTE ON FUNCTION register_artifact(text, text, bigint, text, text)
TO player, admin;

CREATE FUNCTION api.register_artifact(sha256 text, kind text, bytes bigint,
                                      algo_version text, path text DEFAULT NULL)
RETURNS text
LANGUAGE sql AS $$
SELECT public.register_artifact(sha256, kind, bytes, algo_version, path)
$$;
GRANT EXECUTE ON FUNCTION api.register_artifact(text, text, bigint, text, text)
TO player, admin;

-- db/0083's atom_fits, and the version the tab builds. A tab that says
-- nothing about an op is offered every version of it, which is what every
-- test's bare caps mean.
CREATE OR REPLACE FUNCTION atom_fits(a atom, p_caps jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT (NOT coalesce((a.params ->> 'needs_webgpu')::boolean, false)
        OR coalesce((p_caps ->> 'webgpu')::boolean, false))
   AND (p_caps ->> 'max_buffer_mb' IS NULL
        OR (p_caps ->> 'max_buffer_mb')::numeric >= atom_buffer_mb(a))
   AND (p_caps -> 'algo' ->> a.op IS NULL
        OR p_caps -> 'algo' ->> a.op = a.algo_version);
$$;
