-- 0136_whatwasdrawnandofwhat.sql — the Submit panel says what was drawn, and
-- of what.
--
-- TASKS-foundation.md FND.4 step 3. Since db/0135 the world has nine kinds
-- where it had five, and a surveyor who has just pasted an OSM extract into
-- six layers wants to see the six counts before they send it: "12 drawn" is
-- the same sentence whether they pasted twelve roads or a road and eleven
-- trees. `submission_changes` is db/0070's, with one entry more: how many of
-- each kind the land holds.
--
-- It counts the same rows the number beside it counts, so the two cannot
-- disagree — which is why it is here and not a second query in the page.
CREATE OR REPLACE FUNCTION submission_changes(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.dirty AND t.expected_version > 0
                AND is_leaf_tile(t.z, t.x, t.y)
                AND st_intersects((SELECT geom FROM area WHERE id = p_area),
                                  tile_bbox(t.z, t.x, t.y))),
    'objects', (SELECT count(*) FROM instance i
                WHERE i.area_id = p_area AND i.deleted_at IS null),
    'moved', (SELECT count(*) FROM instance i
              WHERE i.area_id = p_area AND i.deleted_at IS null AND i.rev > 1),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = p_area AND f.deleted_at IS null),
    'kinds', coalesce((
        SELECT jsonb_object_agg(k.kind, k.n) FROM (
            SELECT f.kind, count(*) AS n FROM feature f
            WHERE f.area_id = p_area AND f.deleted_at IS null
            GROUP BY f.kind) k), '{}'::jsonb));
$$;
