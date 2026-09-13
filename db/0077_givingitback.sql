-- 0077_givingitback.sql — giving land back.
--
-- SPEC §3 story 11 (PLAYER-RUN.md): "B deletes his land from the Land panel
-- (objects and features go with it, with a confirmation that says what goes);
-- the tiles return to ground".
--
-- db/0038_authoring.sql has `delete_area`, which refuses while anything stands
-- on the land and tells the caller to empty it first. Nothing ever called it:
-- there is no way to empty a piece of land from the page, and asking somebody
-- to remove two hundred trees one at a time before they may give the ground
-- back is not a feature. So this pair replaces it — one function that says
-- what would go, and one that does it — and `delete_area` is dropped rather
-- than left beside them, or the page has two ways to delete land that disagree.
--
-- "Return to ground" is literal: the tile keeps its row, its expected_version
-- and its history, and forgets what was published on it. `tile_state` then
-- says 'ground', the streamer draws nothing there (client/js/traverse.js
-- `showing` reads published_version), and the ground mesh under it comes back.
-- The artifacts themselves are untouched: they are immutable and
-- content-addressed (Invariant 1), and no longer being pointed at is how a
-- world forgets a render.

-- What goes, for the confirmation. Read before the deed and shown in the
-- sentence the player has to agree to.
CREATE FUNCTION land_removal(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'id', a.id,
    'land', coalesce(a.rules ->> 'name', 'unnamed land'),
    'objects', (SELECT count(*) FROM instance i
                WHERE i.area_id = a.id AND i.deleted_at IS null),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = a.id AND f.deleted_at IS null),
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.published_version > 0
                AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y))),
    'grants', (SELECT count(*) FROM grant_ g WHERE g.area_id = a.id),
    'mine', is_area_owner(a.id))
FROM area a WHERE a.id = p_area;
$$;

GRANT EXECUTE ON FUNCTION land_removal(uuid) TO player, admin;

DROP FUNCTION IF EXISTS api.delete_area(uuid);
DROP FUNCTION IF EXISTS delete_area(uuid);

-- The deed. Only the owner: a grant to build on somebody's land is not a grant
-- to give it away.
CREATE FUNCTION remove_area(p_area uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a    area%rowtype;
    went jsonb;
    j    bigint;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such area %', p_area USING errcode = '23503';
    END IF;
    IF NOT (is_area_owner(p_area) OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your land to give back' USING errcode = '42501';
    END IF;
    went := land_removal(p_area);

    -- Nobody is going to render ground that no longer belongs to anybody, and
    -- a bounty on it is money held for work that will not happen.
    FOR j IN SELECT job.id FROM job
             WHERE job.state = 'open'
               AND st_intersects(a.geom, tile_bbox(job.z, job.x, job.y)) LOOP
        UPDATE job SET state = 'cancelled' WHERE id = j;
        PERFORM refund_bounty(j);
    END LOOP;

    -- Before the area, or mark_tiles_dirty (db/0004_tiles.sql) reads a detail
    -- that is already gone and dirties nothing.
    DELETE FROM instance WHERE area_id = p_area;
    DELETE FROM feature WHERE area_id = p_area;

    -- Coarse before fine (db/0010_lockorder.sql).
    UPDATE tile t
    SET published_version = 0, sog_sha256 = NULL, manifest = NULL,
        published_at = NULL, published_by = NULL, refused_note = NULL,
        dirty = false
    WHERE st_intersects(a.geom, tile_bbox(t.z, t.x, t.y))
      AND NOT EXISTS (SELECT 1 FROM area o
                      WHERE o.id <> p_area
                        AND st_intersects(o.geom, tile_bbox(t.z, t.x, t.y)));

    DELETE FROM area WHERE id = p_area;
    RETURN went;
END
$$;

GRANT EXECUTE ON FUNCTION remove_area(uuid) TO player, admin;

CREATE FUNCTION api.land_removal(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT public.land_removal(area_id);
$$;

CREATE FUNCTION api.remove_area(area_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.remove_area(area_id);
$$;

GRANT EXECUTE ON FUNCTION api.land_removal(uuid), api.remove_area(uuid)
TO player, admin;
