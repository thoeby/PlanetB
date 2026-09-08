-- 0018_spot.sql — WP3.3: the free check every owner does by walking around.
--
-- Three tabs looked at a tile once, at the moment it was made. The people who
-- own the ground it stands on look at it for ever, and their tabs already have
-- the .sog in front of them. So: when a tab loads a tile it did not publish,
-- inside an area its user may write, and it has not looked at that tile for a
-- week, it does the check again — perceptually for a trained tile, and by
-- asking for a recomputation for a deterministic one (recheck_atom,
-- db/0015_structural.sql).
--
-- A failed spot check does not unpublish anything. It marks the tile `suspect`,
-- which is a claim about the world that the world can then act on, and blames
-- the trainer.

ALTER TABLE tile ADD COLUMN suspect boolean NOT NULL DEFAULT false;
CREATE INDEX tile_suspect_idx ON tile (suspect) WHERE suspect;

-- CREATE VIEW froze the column list when it expanded `*`; this re-expands it.
CREATE OR REPLACE VIEW api.tile WITH (security_invoker = true)
AS SELECT * FROM public.tile;

-- Publishing a tile answers whatever the last one was suspected of.
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
    IF j.z > 6 THEN
        PERFORM 1 FROM tile t
        WHERE t.z = j.z - 2 AND t.x = j.x / 4 AND t.y = j.y / 4 FOR UPDATE;
    END IF;

    UPDATE tile t
    SET published_version = j.target_version,
        sog_sha256 = a.output_sha256,
        manifest = p_manifest,
        published_at = now(),
        published_by = p_by,
        suspect = false,
        dirty = t.expected_version > j.target_version
    WHERE t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.expected_version = j.target_version
      AND t.published_version < j.target_version;
    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = j.id;
    PERFORM release_escrow(j.id);
    IF j.z > 6 THEN
        PERFORM dirty_parent(j.z, j.x, j.y);
    END IF;
    RETURN true;
END
$$;

-- ---------------------------------------------------------------- is it due
--
-- Everything the client cannot answer for itself: whether this tile is one of
-- mine to police, whether I am the wrong person to ask, and what checking it
-- would consist of. SECURITY DEFINER because it reads other people's atoms;
-- it changes nothing and tells the caller only about tiles they may write.

CREATE FUNCTION spot_sog(p_z int, p_x int, p_y int) RETURNS atom
LANGUAGE sql STABLE AS $$
SELECT a.* FROM atom a
JOIN job j ON j.id = a.job_id
JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
WHERE a.op = 'sog' AND t.z = p_z AND t.x = p_x AND t.y = p_y
  AND a.output_sha256 = t.sog_sha256
  AND j.target_version = t.published_version
ORDER BY a.id DESC LIMIT 1;
$$;

CREATE FUNCTION spot_due(z int, x int, y int, days int DEFAULT 7)
RETURNS TABLE (kind text, atom_id bigint, inputs jsonb, params jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t   tile%rowtype;
    uid uuid := current_user_id();
    wid uuid;
    sg  atom%rowtype;
BEGIN
    SELECT * INTO t FROM tile
    WHERE tile.z = spot_due.z AND tile.x = spot_due.x AND tile.y = spot_due.y;
    IF uid IS NULL OR t.z IS NULL OR t.published_version = 0
       OR t.published_by = uid THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM area a
                   WHERE st_intersects(a.geom, tile_bbox(spot_due.z, spot_due.x, spot_due.y))
                     AND is_area_writer(a.id)) THEN
        RETURN;
    END IF;

    sg := spot_sog(spot_due.z, spot_due.x, spot_due.y);
    SELECT worker.id INTO wid FROM worker WHERE worker.user_id = uid;
    IF sg.id IS NULL THEN
        RETURN;
    END IF;
    -- A tab that has never worked has no worker row yet, and cannot be the one
    -- that made this tile.
    IF wid IS NOT NULL AND NOT may_verify(sg.job_id, NULL, wid) THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM verification v
               WHERE v.atom_id = sg.id AND v.verifier_worker_id = wid
                 AND v.at > now() - make_interval(days => spot_due.days)) THEN
        RETURN;
    END IF;

    -- A trained tile is checked by looking at it; a merged or sampled one by
    -- asking for the arithmetic again, which is what a recheck is.
    IF spot_due.z >= 16 THEN
        RETURN QUERY
        SELECT 'perceptual', sg.id, v.inputs, v.params
        FROM atom v WHERE v.job_id = sg.job_id AND v.op = 'verify'
        ORDER BY v.id LIMIT 1;
    ELSE
        RETURN QUERY SELECT 'hash', sg.id, sg.inputs, sg.params;
    END IF;
END
$$;

GRANT EXECUTE ON FUNCTION spot_due(int, int, int, int) TO player, admin;

CREATE FUNCTION api.spot_due(z int, x int, y int, days int DEFAULT 7)
RETURNS TABLE (kind text, atom_id bigint, inputs jsonb, params jsonb)
LANGUAGE sql STABLE AS $$SELECT * FROM public.spot_due(z, x, y, days)$$;
GRANT EXECUTE ON FUNCTION api.spot_due(int, int, int, int) TO player, admin;

-- ------------------------------------------------------------- a bad answer
--
-- db/0017_verify.sql's, with the tile flagged. A tile that has already been
-- published is not sent back to its trainer: publish_tile is a compare-and-swap
-- against `expected_version` (Invariant 3), so a second run at the same version
-- could never publish, and re-opening the job would only look like progress.
-- `suspect` is the honest signal, and what acts on it is WP4's business.
CREATE OR REPLACE FUNCTION rejected(a atom, trainer uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    published boolean;
BEGIN
    IF trainer IS NOT NULL THEN
        INSERT INTO worker_op_stats (worker_id, op, bad) VALUES (trainer, 'train', 1)
        ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
    END IF;
    UPDATE tile t SET suspect = true
    FROM job j
    WHERE j.id = a.job_id AND t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.sog_sha256 = a.output_sha256
    RETURNING true INTO published;
    IF coalesce(published, false) THEN
        RETURN 'suspect';
    END IF;
    RETURN retrain(a);
END
$$;
