-- 0085_landanadmincantakeback.sql — land an admin can take back.
--
-- Every other thing in this world can be undone: a property is dropped, a rule
-- is deleted, a grant is given back, a job is cancelled. Land could only ever
-- be made. An admin who drew a boundary in the wrong place, or assigned it to
-- the wrong person, had a row nothing could reach and a piece of the world that
-- would be compiled from it for ever.
--
-- What deleting land means, in order:
--
--   * the ground it covered is changed, because what stood on it no longer
--     does — so the tiles under it are dirty at a new version and go through
--     Submit like any other change (Invariant 4: this marks, it opens nothing);
--   * the jobs open on it are superseded, and their escrow goes back
--     (db/0084, Invariant 5 — refund_bounty's transfers are ref-idempotent);
--   * what stood on it goes with it: the features somebody drew and the
--     instances they placed are that land's, and the FKs say so (NO ACTION),
--     so there is no delete without them;
--   * the proposals about it, which are questions about ground that has gone;
--   * and the area itself, which cascades its grants, its grant requests and
--     its submissions, and leaves the land request that asked for it 'assigned'
--     with nothing to point at.
--
-- What does not go: every artifact any of it was ever compiled into. Those are
-- immutable and content-addressed (Invariant 1) and an atom recorded what it
-- read by hash (Invariant 2), so the history of the tile stays readable. What
-- changes is what the next compile of that ground will contain.
--
-- Admin only. Not the owner: giving land back is what an owner does
-- (db/0077_givingitback.sql), and that returns it to the world rather than
-- deleting it.

-- Every piece of land there is, for the tool that has to see all of them. The
-- Admin map drew `my_areas` — the admin's own — so a boundary was drawn with
-- no way to see whose ground it was going to touch.
CREATE FUNCTION all_areas() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT CASE WHEN current_user_role() = 'admin'
    THEN coalesce((SELECT jsonb_agg(area_view(a) || jsonb_build_object(
                       'owner', player_name(a.owner_id),
                       'things', (SELECT count(*) FROM instance i
                                  WHERE i.area_id = a.id AND i.deleted_at IS null),
                       'drawn', (SELECT count(*) FROM feature f
                                 WHERE f.area_id = a.id AND f.deleted_at IS null))
                       ORDER BY a.created_at)
                   FROM area a), '[]'::jsonb)
    ELSE '[]'::jsonb END;
$$;

GRANT EXECUTE ON FUNCTION all_areas() TO player, admin;

CREATE FUNCTION api.all_areas() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$SELECT public.all_areas()$$;

GRANT EXECUTE ON FUNCTION api.all_areas() TO player, admin;

-- Taking it back. One transaction, and the tiles are marked before the jobs
-- are cancelled so that supersede_jobs sees the version they have moved past.
CREATE FUNCTION delete_area(p_area uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a     area%rowtype;
    tiles int := 0;
    jobs  int := 0;
    name  text;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin may delete land' USING errcode = '42501';
    END IF;
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such land %', p_area USING errcode = '23503';
    END IF;
    name := coalesce(nullif(a.rules ->> 'name', ''), 'that land');

    -- The ground it covered has changed. Coarse before fine
    -- (db/0010_lockorder.sql).
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1
    FROM tiles_for_geom(a.geom, 6, a.detail) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS tiles = ROW_COUNT;
    jobs := supersede_jobs(a.geom);

    DELETE FROM proposal WHERE area_id = p_area;
    DELETE FROM instance WHERE area_id = p_area;
    DELETE FROM feature WHERE area_id = p_area;
    DELETE FROM area WHERE id = p_area;

    RETURN jsonb_build_object('name', name, 'tiles', tiles, 'jobs', jobs);
END
$$;

GRANT EXECUTE ON FUNCTION delete_area(uuid) TO admin;

CREATE FUNCTION api.delete_area(area_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.delete_area(area_id);
$$;

GRANT EXECUTE ON FUNCTION api.delete_area(uuid) TO admin;
