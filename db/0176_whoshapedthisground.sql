-- 0176_whoshapedthisground.sql — who shaped this land, and when.
--
-- `height_edit` has carried `saved_by` and `saved_at` since db/0163 and
-- nothing ever read them. The Shape panel could say what you have done to the
-- ground in this session and nothing at all about what was already there: a
-- land somebody else flattened last week looked exactly like a land nobody had
-- touched, and the only way to find out was to drag a brush and watch what
-- moved.
--
-- Reading is public in this world, as `height_edit`'s own policy says; saving
-- is not, and this does not save anything.
CREATE FUNCTION shaping_of(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce((
    SELECT jsonb_build_object(
        'rev', e.rev, 'at', e.saved_at, 'sha256', e.sha256,
        'who', coalesce(player_name(e.saved_by), 'somebody'),
        'mine', e.saved_by IS NOT DISTINCT FROM current_user_id(),
        'times', (SELECT count(*) FROM height_edit h WHERE h.area_id = p_area))
    FROM height_edit e
    WHERE e.area_id = p_area
    ORDER BY e.rev DESC LIMIT 1),
    jsonb_build_object('rev', 0, 'times', 0));
$$;
GRANT EXECUTE ON FUNCTION shaping_of(uuid) TO anon, player, admin;

CREATE FUNCTION api.shaping_of(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.shaping_of(p_area)$$;
GRANT EXECUTE ON FUNCTION api.shaping_of(uuid) TO anon, player, admin;
