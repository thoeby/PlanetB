-- 0044_permission.sql — a rendered tile is a candidate until a person says so.
--
-- TASKS-usable T7: approval is a person, not a check. What a stranger's browser
-- renders lands as a candidate on the tile; the owner of the land under it — or
-- somebody they granted `approve` to — looks at it in place and publishes it, or
-- refuses it with a note. Until then everyone else sees what was there before.
--
-- This is also what replaces the trust-gated verify atoms as the publish gate.
-- Three strangers agreeing that a picture has a high enough PSNR was never the
-- same question as "is this what I wanted on my land", and it stood in the way
-- of the person who could actually answer.
--
-- The deterministic hash checks stay: merge, sample and sog still have to agree
-- with themselves (db/0016_sample.sql). That is plumbing, and nobody is asked
-- to look at it.

ALTER TABLE tile
    ADD COLUMN candidate_version bigint,
    ADD COLUMN candidate_sha256 text REFERENCES artifact (sha256),
    ADD COLUMN candidate_manifest jsonb,
    ADD COLUMN candidate_by uuid,
    ADD COLUMN candidate_at timestamptz,
    ADD COLUMN refused_note text;
CREATE INDEX tile_candidate_idx ON tile (z, x, y) WHERE candidate_sha256 IS NOT null;

-- The viewer reads the candidate through the same row it reads the published
-- tile from, so the switch has a sha to ask for (client/js/traverse.js). The
-- view froze its column list when it expanded `*`; this re-expands it, the same
-- way db/0018_spot.sql had to.
CREATE OR REPLACE VIEW api.tile WITH (security_invoker = true)
AS SELECT * FROM public.tile;

-- Who may say yes to what is on this ground: whoever owns land it touches, and
-- whoever they granted `approve` to. An admin may always.
-- search_path is pinned because PostgREST puts `api` first, and api.tile is a
-- view of this table: unqualified `tile` would resolve to the view.
CREATE FUNCTION may_approve_tile(p_z int, p_x int, p_y int) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT current_user_role() = 'admin' OR EXISTS (
    SELECT 1 FROM area a
    WHERE (is_area_owner(a.id) OR has_area_right(a.id, 'approve'))
      AND st_intersects(a.geom, tile_bbox(p_z, p_x, p_y)));
$$;
GRANT EXECUTE ON FUNCTION may_approve_tile(int, int, int) TO anon, player, admin;

-- db/0017_verify.sql's publish_sog, one step shorter: the bytes become the
-- tile's candidate rather than the tile. The renderer is paid here — they did
-- the work, and whether the owner likes the result is not their risk (T6).
CREATE OR REPLACE FUNCTION publish_sog(a atom, p_by uuid, p_manifest jsonb)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    j job%rowtype;
BEGIN
    SELECT * INTO j FROM job WHERE id = a.job_id;
    IF j.id IS NULL OR a.output_sha256 IS NULL OR p_manifest IS NULL THEN
        RETURN false;
    END IF;

    -- Invariant 3 unchanged: the compare-and-swap is on expected_version, so a
    -- worker holding a stale render can never put it forward.
    UPDATE tile t
    SET candidate_version = j.target_version,
        candidate_sha256 = a.output_sha256,
        candidate_manifest = p_manifest,
        candidate_by = p_by,
        candidate_at = now(),
        refused_note = NULL,
        dirty = t.expected_version > j.target_version
    WHERE t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.expected_version = j.target_version
      AND t.published_version < j.target_version
      AND coalesce(t.candidate_version, 0) < j.target_version;
    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = j.id;
    PERFORM release_escrow(j.id);
    RETURN true;
END
$$;

-- Yes. The candidate becomes what everybody sees, and the parent is dirtied so
-- the ladder above it follows — which is where the coarse-before-fine lock
-- order matters (db/0010_lockorder.sql).
CREATE FUNCTION approve_tile(p_z int, p_x int, p_y int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t tile%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT may_approve_tile(p_z, p_x, p_y) THEN
        RAISE EXCEPTION 'that is not your ground to approve' USING errcode = '42501';
    END IF;
    IF p_z > 6 THEN
        PERFORM 1 FROM tile parent
        WHERE parent.z = p_z - 2 AND parent.x = p_x / 4 AND parent.y = p_y / 4
        FOR UPDATE;
    END IF;
    SELECT * INTO t FROM tile
    WHERE tile.z = p_z AND tile.x = p_x AND tile.y = p_y FOR UPDATE;
    IF t.z IS NULL OR t.candidate_sha256 IS NULL THEN
        RETURN false;
    END IF;

    UPDATE tile
    SET published_version = t.candidate_version,
        sog_sha256 = t.candidate_sha256,
        manifest = t.candidate_manifest,
        published_at = now(),
        published_by = t.candidate_by,
        candidate_version = NULL, candidate_sha256 = NULL,
        candidate_manifest = NULL, candidate_by = NULL, candidate_at = NULL
    WHERE tile.z = p_z AND tile.x = p_x AND tile.y = p_y;

    IF p_z > 6 THEN
        PERFORM dirty_parent(p_z, p_x, p_y);
    END IF;
    RETURN true;
END
$$;

-- No. What was published stays published; the note is for whoever rendered it
-- and whoever owns the land, and the tile is dirty again so it can be tried.
CREATE FUNCTION refuse_tile(p_z int, p_x int, p_y int, p_note text DEFAULT '')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT may_approve_tile(p_z, p_x, p_y) THEN
        RAISE EXCEPTION 'that is not your ground to refuse' USING errcode = '42501';
    END IF;
    UPDATE tile
    SET candidate_version = NULL, candidate_sha256 = NULL,
        candidate_manifest = NULL, candidate_by = NULL, candidate_at = NULL,
        refused_note = nullif(p_note, ''), dirty = true
    WHERE tile.z = p_z AND tile.x = p_x AND tile.y = p_y
      AND tile.candidate_sha256 IS NOT NULL;
    RETURN found;
END
$$;

-- What is waiting for you to look at it, nearest first if you say where you are.
CREATE FUNCTION my_candidates(p_lon double precision DEFAULT null,
                              p_lat double precision DEFAULT null,
                              p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(c ORDER BY c ->> 'metres', c ->> 'at'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'z', t.z, 'x', t.x, 'y', t.y,
        'version', t.candidate_version, 'sha256', t.candidate_sha256,
        'by', t.candidate_by, 'at', t.candidate_at,
        'manifest', t.candidate_manifest,
        'was_published', t.published_version > 0,
        'centre', jsonb_build_object(
            'lon', st_x(st_centroid(tile_bbox(t.z, t.x, t.y))),
            'lat', st_y(st_centroid(tile_bbox(t.z, t.x, t.y)))),
        'metres', CASE WHEN p_lon IS NULL THEN 0 ELSE
            st_distance(st_centroid(tile_bbox(t.z, t.x, t.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) END) AS c
    FROM tile t
    WHERE t.candidate_sha256 IS NOT NULL AND may_approve_tile(t.z, t.x, t.y)
    LIMIT greatest(p_limit, 0)
) waiting;
$$;
GRANT EXECUTE ON FUNCTION my_candidates(double precision, double precision, int)
TO anon, player, admin;

-- ------------------------------------------------------------- the old gate
--
-- A sog no longer waits for three strangers to agree about a PSNR. It is
-- verified when it is submitted, like every other deterministic op, and then it
-- is a candidate for a person to look at. The verify atoms are not built any
-- more, so nothing is left waiting on them.

CREATE OR REPLACE FUNCTION submit_atom(p_atom bigint, p_output text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a     atom%rowtype;
    wid   uuid := my_worker(NULL);
    bytes bigint;
    broke text;
BEGIN
    SELECT * INTO a FROM atom WHERE atom.id = p_atom FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such atom %', p_atom;
    END IF;
    IF a.state <> 'claimed' OR a.worker_id <> wid THEN
        RAISE EXCEPTION 'atom % is % and claimed by %, not submittable by you',
            p_atom, a.state, a.worker_id;
    END IF;

    bytes := coalesce(
        (SELECT artifact.bytes FROM artifact WHERE sha256 = p_output),
        (p_result ->> 'bytes')::bigint, 0);

    broke := run_structural(a, coalesce(p_result, '{}'::jsonb), bytes);
    IF broke IS NOT NULL THEN
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'structural', false, jsonb_build_object('rule', broke));
        UPDATE atom SET attempts = attempts + 1,
            state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
        WHERE atom.id = a.id;
        RETURN (SELECT state FROM atom WHERE atom.id = a.id);
    END IF;

    -- Deterministic ops still have to agree with themselves: two answers for
    -- one atom_hash and neither is trusted (db/0016_sample.sql).
    IF deterministic(a.op) AND a.output_sha256 IS NOT NULL THEN
        IF a.output_sha256 <> p_output THEN
            PERFORM disagreed(a, wid, p_output);
            RETURN (SELECT state FROM atom WHERE atom.id = a.id);
        END IF;
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'hash', true,
                jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed)
    VALUES (a.id, wid, 'structural', true);

    -- Work accepted is still work done: a tab that keeps finishing atoms gains
    -- standing and its ops are counted (db/0019_trust.sql). What T7 takes away
    -- is trust as the gate on publishing, not the record of who does the work.
    PERFORM credit(wid, trust_work());
    PERFORM record_ok(wid, a.op);

    UPDATE atom SET state = 'verified', output_sha256 = p_output,
                    result = p_result, heartbeat_at = now()
    WHERE atom.id = a.id;

    PERFORM advance_atoms(a.job_id);
    RETURN 'verified';
END
$$;

-- db/0039_ground.sql's build_dag without the three verify atoms: a person is
-- the gate now.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
BEGIN
    IF a_z >= 14 THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF a_z = 14 THEN
        smp := new_atom(a_job, 'sample', 'sample-v1',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

GRANT EXECUTE ON FUNCTION approve_tile(int, int, int),
    refuse_tile(int, int, int, text) TO player, admin;

CREATE FUNCTION api.approve_tile(z int, x int, y int) RETURNS boolean
LANGUAGE sql AS $$SELECT public.approve_tile(z, x, y)$$;
CREATE FUNCTION api.refuse_tile(z int, x int, y int, note text DEFAULT '')
RETURNS boolean LANGUAGE sql AS $$SELECT public.refuse_tile(z, x, y, note)$$;
CREATE FUNCTION api.my_candidates(lon double precision DEFAULT null,
                                  lat double precision DEFAULT null,
                                  "limit" int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_candidates(lon, lat, "limit")$$;

GRANT EXECUTE ON FUNCTION api.approve_tile(int, int, int),
    api.refuse_tile(int, int, int, text) TO player, admin;
GRANT EXECUTE ON FUNCTION api.my_candidates(double precision, double precision, int)
TO anon, player, admin;
