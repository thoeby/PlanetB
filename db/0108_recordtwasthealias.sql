-- 0108_recordtwasthealias.sql — compile_ground made no job at all.
--
-- db/0104's compile_ground declared a record `t` and then wrote a query with
-- a table alias `t`. PL/pgSQL resolves `t.z` to the variable, which has no
-- value yet — "record t is not assigned yet" — and the function failed before
-- it had made one tile. So a new ground rendered nothing, and "Render the
-- whole ground again" said so only in the Setup panel's status line. The
-- aliases are different names now, and the test asserts that jobs come out.
CREATE OR REPLACE FUNCTION compile_ground() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    g   ground%rowtype;
    at  record;
    n   int := 0;
BEGIN
    SELECT * INTO g FROM ground;
    IF g.extent IS NULL THEN
        RETURN 0;
    END IF;
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT tg.z, tg.x, tg.y, true, 1 FROM tiles_for_geom(g.extent, 6, 14) AS tg
    ORDER BY tg.z, tg.x, tg.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    PERFORM supersede_jobs(g.extent);
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR at IN SELECT tile.x, tile.y FROM tile
              WHERE tile.z = 14 AND st_intersects(tile_bbox(14, tile.x, tile.y), g.extent)
              ORDER BY tile.x, tile.y LOOP
        PERFORM ensure_job(14, at.x, at.y);
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;
