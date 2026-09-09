-- 0025_tilesforgeom.sql — the dirty trigger's own planning cost.
--
-- tiles_for_geom() is `LANGUAGE sql`, so the planner inlines it, and inlining
-- puts its three generate_series into the caller's plan. The planner then
-- estimates 5000 rows for what is really five and costs the join at 6.4e7 —
-- far above jit_above_cost — so PostgreSQL compiles an expression for every
-- call. Measured on this schema: 158 ms a feature inserted, of which 165 ms is
-- JIT and 0.15 ms is work.
--
-- A per-function `SET` clause is what stops the inlining (a function with a SET
-- clause cannot be inlined, because its GUC has to be established around the
-- call), and the value says what to do when it is not: no JIT for a plan whose
-- whole body is arithmetic. Both halves are wanted, and this is the one line
-- that gets both. After it: Function Scan at cost 10.25, 0.95 ms a feature.
--
-- Every writer pays this, not only the seeds: the trigger runs on every
-- feature and instance insert, update and delete (Invariant 4, db/0004_tiles.sql).
ALTER FUNCTION tiles_for_geom(geometry, int, int) SET jit = off;

-- What the plan is, as text, so a test can assert the shape rather than the
-- timing — a wall-clock assertion on a shared box is a flake waiting to happen.
CREATE FUNCTION explain_text(p_query text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    r   record;
    out text := '';
BEGIN
    FOR r IN EXECUTE 'EXPLAIN ' || p_query LOOP
        out := out || r."QUERY PLAN" || E'\n';
    END LOOP;
    RETURN out;
END
$$;
