-- 0010_lockorder.sql — every writer takes `tile` row locks coarse before fine.
--
-- Two paths lock more than one tile in a transaction:
--
--   mark_tiles_dirty()  every tile a feature touches, z6 up to area.detail
--   publish_tile()      the published tile, then dirty_parent() on its parent
--
-- tiles_for_geom hands rows back coarse-first and mark_tiles_dirty passed them
-- straight to the upsert, so an editor took z6 first — and since one z6 tile
-- covers everything anyone is editing, that first lock serialised the editors
-- against each other. publish_tile ran the other way: it CASes the child and
-- only then dirties the parent. An editor holding z12 and waiting on z14,
-- against a worker holding z14 and waiting on z12, is a cycle, and the WP0.7
-- torture test hit it about one run in eight.
--
-- The fix is to make publish_tile agree: it takes the parent's row lock before
-- it touches the child, so both paths run coarse to fine. The ORDER BY on the
-- upsert makes explicit the order tiles_for_geom already happened to produce,
-- so nothing depends on that accident any more.
--
-- Going the other way — sorting the upsert (z DESC, x, y) so editors run fine
-- to coarse — was tried and is far worse: it gives up the z6 serialisation and
-- the same run produced 110 deadlocks instead of one.
--
-- Invariant 4 still holds: the trigger only marks dirty and bumps
-- expected_version. Invariant 3 still holds: the compare-and-swap below is
-- unchanged, and the extra lock is taken before it, not instead of it.

CREATE OR REPLACE FUNCTION mark_tiles_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    row_area_id uuid;
    depth       smallint;
    g           geometry;
BEGIN
    -- A move dirties where the row was and where it now is.
    IF tg_op = 'INSERT' THEN
        row_area_id := new.area_id;
        g := new.geom;
    ELSIF tg_op = 'DELETE' THEN
        row_area_id := old.area_id;
        g := old.geom;
    ELSE
        row_area_id := new.area_id;
        g := st_collect(old.geom, new.geom);
    END IF;
    SELECT detail INTO depth FROM area WHERE id = row_area_id;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(g, 6, depth) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION publish_tile(z int, x int, y int, target_version bigint,
                                        sog_sha256 text, manifest jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid := my_worker(NULL);
    jid bigint;
BEGIN
    SELECT j.id INTO jid
    FROM job j
    JOIN atom a ON a.job_id = j.id AND a.op = 'sog' AND a.state = 'verified'
    WHERE j.z = publish_tile.z AND j.x = publish_tile.x AND j.y = publish_tile.y
      AND j.target_version = publish_tile.target_version
      AND a.worker_id = wid
      AND a.output_sha256 = publish_tile.sog_sha256;
    IF jid IS NULL THEN
        RAISE EXCEPTION
            'no verified sog of yours for %/%/% at version %', z, x, y, target_version;
    END IF;

    -- Coarse before fine, so this agrees with mark_tiles_dirty. The parent is
    -- only *written* if the swap below succeeds; taking its lock early costs
    -- nothing, because a successful publish would take it anyway.
    IF z > 6 THEN
        PERFORM 1 FROM tile t
        WHERE t.z = publish_tile.z - 2
          AND t.x = publish_tile.x / 4 AND t.y = publish_tile.y / 4
        FOR UPDATE;
    END IF;

    UPDATE tile t
    SET published_version = publish_tile.target_version,
        sog_sha256 = publish_tile.sog_sha256,
        manifest = publish_tile.manifest,
        published_at = now(),
        published_by = current_user_id(),
        dirty = t.expected_version > publish_tile.target_version
    WHERE t.z = publish_tile.z AND t.x = publish_tile.x AND t.y = publish_tile.y
      AND t.expected_version = publish_tile.target_version
      AND t.published_version < publish_tile.target_version;

    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = jid;
    PERFORM release_escrow(jid);

    IF z > 6 THEN
        PERFORM dirty_parent(publish_tile.z, publish_tile.x, publish_tile.y);
    END IF;
    RETURN true;
END
$$;
