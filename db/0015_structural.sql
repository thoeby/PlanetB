-- 0015_structural.sql — the cheap checks, live.
--
-- submit_atom already refused empty artifacts and over-budget counts. This adds
-- the rest of the set WP2.7 asks for — a bounding box inside the tile, a finite
-- result, a frame atom that rendered exactly the range it was given — and makes
-- the deterministic ops answer for a second opinion.
--
-- A rule is a row, not code: run_structural() executes it with $1 = the atom,
-- $2 = the submitted result and $3 = the artifact's size.

-- The tile's width on the ground, which is what "inside the tile" means. A
-- Web-Mercator tile is wider at its equator-facing edge than at its middle —
-- by 30 m or so at z10 — and a splat in that corner is still inside it, so this
-- is the widest the tile ever is.
CREATE FUNCTION tile_edge_m(z int, x int, y int) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT greatest(
    st_distance(st_point(st_xmin(b), st_ymin(b))::geography,
                st_point(st_xmax(b), st_ymin(b))::geography),
    st_distance(st_point(st_xmin(b), st_ymax(b))::geography,
                st_point(st_xmax(b), st_ymax(b))::geography))
FROM (SELECT tile_bbox(z, x, y) AS b) AS t;
$$;

-- result.bbox is [minx, miny, minz, maxx, maxy, maxz] in the tile's own frame,
-- metres. Anything that produces splats has to say where they are, and they
-- have to be within a tile's width of its middle (ARCHITECTURE §2), plus a
-- margin for the buildings and trees that overhang the edge.
CREATE FUNCTION bbox_fits(a atom, r jsonb, margin double precision DEFAULT 10)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    j    job%rowtype;
    b    double precision [];
    half double precision;
BEGIN
    IF r -> 'bbox' IS NULL OR jsonb_array_length(r -> 'bbox') <> 6 THEN
        RETURN false;
    END IF;
    SELECT * INTO j FROM job WHERE job.id = a.job_id;
    IF j.id IS NULL THEN RETURN false; END IF;
    SELECT array_agg(v::double precision ORDER BY o)
    INTO b FROM jsonb_array_elements_text(r -> 'bbox') WITH ORDINALITY AS e (v, o);
    half := tile_edge_m(j.z, j.x, j.y) / 2 + margin;
    -- Height is bounded loosely: a big tile's own curvature drops its corners
    -- kilometres below its middle, and this is here to catch nonsense, not to
    -- have an opinion about how steep a mountain may be.
    RETURN abs(b[1]) <= half AND abs(b[4]) <= half
        AND abs(b[3]) <= half AND abs(b[6]) <= half
        AND abs(b[2]) <= greatest(half * 2, 20000)
        AND abs(b[5]) <= greatest(half * 2, 20000)
        AND b[1] <= b[4] AND b[2] <= b[5] AND b[3] <= b[6];
END
$$;

INSERT INTO structural_rule (op, name, rule) VALUES
('assemble', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('frame', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('train', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('merge', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('sog', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('assemble', 'bbox', 'bbox_fits($1, $2)'),
('train', 'bbox', 'bbox_fits($1, $2)'),
('merge', 'bbox', 'bbox_fits($1, $2)'),
('sog', 'bbox', 'bbox_fits($1, $2)'),
('assemble', 'budget',
 'coalesce(($2 ->> ''splat_count'')::bigint, 0) <= (($1).params ->> ''budget'')::bigint'),
('frame', 'range',
 'coalesce(($2 ->> ''frames'')::int, -1) = (($1).params ->> ''to'')::int
  - (($1).params ->> ''from'')::int');

-- ------------------------------------------------------------------ submit
--
-- Same as db/0005_state.sql's, with one change: when a deterministic op is
-- submitted a second time and the two answers differ, neither is trusted. The
-- output is discarded, both workers are marked bad for that op, and the atom
-- goes back to the pool for a third opinion — failing for good on the third
-- attempt, which is what every other bad result does here (db/0005_state.sql).

CREATE FUNCTION disagreed(a atom, wid uuid, p_output text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
    VALUES (a.id, wid, 'hash', false,
            jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    -- DISTINCT because the two answers can come from the same worker, and one
    -- row may only be touched once by an upsert.
    INSERT INTO worker_op_stats (worker_id, op, bad)
    SELECT DISTINCT w, a.op, 1 FROM unnest(ARRAY[wid, a.worker_id]) AS u (w)
    WHERE w IS NOT NULL
    ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
    UPDATE atom SET attempts = attempts + 1,
        state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        output_sha256 = NULL, result = NULL,
        worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state <> 'cancelled';
END
$$;

CREATE OR REPLACE FUNCTION submit_atom(p_atom bigint, p_output text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a        atom%rowtype;
    j        job%rowtype;
    wid      uuid := my_worker(NULL);
    bytes    bigint;
    broke    text;
    newstate text;
BEGIN
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such atom %', p_atom;
    END IF;
    IF a.state <> 'claimed' OR a.worker_id <> wid THEN
        RAISE EXCEPTION 'atom % is % and claimed by %, not submittable by you',
            p_atom, a.state, a.worker_id;
    END IF;
    SELECT * INTO j FROM job WHERE id = a.job_id;

    bytes := coalesce(
        (SELECT artifact.bytes FROM artifact WHERE sha256 = p_output),
        (p_result ->> 'bytes')::bigint, 0);

    broke := run_structural(a, coalesce(p_result, '{}'::jsonb), bytes);
    IF broke IS NOT NULL THEN
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'structural', false,
                jsonb_build_object('rule', broke));
        UPDATE atom SET attempts = attempts + 1,
            state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
        WHERE id = a.id RETURNING state INTO newstate;
        RETURN newstate;
    END IF;

    -- Deterministic ops: a second, different answer for the same atom_hash
    -- means one of the two workers is wrong, so neither result is trusted.
    IF a.op IN ('merge', 'sog') AND a.output_sha256 IS NOT NULL THEN
        IF a.output_sha256 <> p_output THEN
            PERFORM disagreed(a, wid, p_output);
            RETURN (SELECT state FROM atom WHERE id = a.id);
        END IF;
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'hash', true,
                jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed)
    VALUES (a.id, wid, 'structural', true);

    -- Trained tiles are only probabilistically verified (Invariant 8): their
    -- .sog waits for three independent perceptual checks. Everything else is
    -- deterministic and is accepted here.
    newstate := CASE WHEN a.op = 'sog' AND j.z >= 16 THEN 'submitted'
                     ELSE 'verified' END;
    UPDATE atom SET state = newstate, output_sha256 = p_output,
                    result = p_result, heartbeat_at = now()
    WHERE id = a.id;

    PERFORM advance_atoms(a.job_id);
    RETURN newstate;
END
$$;

-- ----------------------------------------------------------------- rechecks
--
-- A second opinion has to be askable, or the comparison above can never happen:
-- a settled deterministic atom goes back to the pool with its answer still on
-- it, and the next worker's answer is measured against that one. This is the
-- hook ARCHITECTURE §8 describes ("re-computed by the next claimant") and what
-- WP3.3's owner spot-check will pull.

CREATE OR REPLACE FUNCTION atom_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed text [];
BEGIN
    IF new.state = old.state THEN
        RETURN new;
    END IF;
    allowed := CASE old.state
        WHEN 'waiting' THEN ARRAY['ready', 'failed']
        WHEN 'ready' THEN ARRAY['claimed', 'failed', 'waiting']
        WHEN 'claimed' THEN ARRAY['ready', 'submitted', 'verified', 'failed']
        WHEN 'submitted' THEN ARRAY['verified', 'failed', 'ready']
        -- verified -> ready is a recheck, and only recheck_atom() does it.
        WHEN 'verified' THEN ARRAY['failed', 'ready']
        WHEN 'failed' THEN ARRAY['ready', 'waiting']
    END;
    IF NOT (new.state = ANY (allowed)) THEN
        RAISE EXCEPTION 'illegal atom transition % -> %', old.state, new.state;
    END IF;
    IF new.state = 'claimed' AND (new.worker_id IS NULL OR new.claimed_at IS NULL) THEN
        RAISE EXCEPTION 'a claimed atom needs a worker and a claim time';
    END IF;
    RETURN new;
END
$$;

CREATE FUNCTION recheck_atom(p_atom bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a atom%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.op NOT IN ('merge', 'sog') OR a.state <> 'verified' THEN
        RETURN false;
    END IF;
    -- The answer stays on the atom: it is what the next one is compared to.
    UPDATE atom SET state = 'ready', worker_id = NULL,
                    claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state = 'done';
    RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION recheck_atom(bigint) TO player, admin;

CREATE FUNCTION api.recheck_atom(atom_id bigint) RETURNS boolean
LANGUAGE sql AS $$SELECT public.recheck_atom(atom_id)$$;
GRANT EXECUTE ON FUNCTION api.recheck_atom(bigint) TO player, admin;
