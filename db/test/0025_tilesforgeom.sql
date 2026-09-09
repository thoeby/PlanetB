-- What the dirty trigger costs to plan (db/0025_tilesforgeom.sql). The
-- assertion is on the shape of the plan, not on a stopwatch: a wall-clock
-- threshold on a shared box is a flake, and the shape is what decides whether
-- PostgreSQL compiles an expression for every feature somebody draws.
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE p AS
SELECT explain_text($q$SELECT * FROM tiles_for_geom(
    st_makeenvelope(8.0, 47.0, 8.1, 47.1, 4326), 6, 14)$q$) AS txt;

SELECT matches((SELECT txt FROM p), 'Function Scan on tiles_for_geom',
    'tiles_for_geom is not inlined into its caller');
SELECT doesnt_match((SELECT txt FROM p), 'generate_series',
    'so its three generate_series are not the caller plan''s problem');

-- The number that decides whether the plan is JIT-compiled. Inlined it was
-- 6.4e7 against a default jit_above_cost of 1e5.
SELECT cmp_ok(
    (SELECT substring(txt from 'cost=[0-9.]+\.\.([0-9.]+)')::numeric FROM p),
    '<', current_setting('jit_above_cost')::numeric,
    'and the plan costs less than jit_above_cost, so nothing is compiled');

-- The reason it is not inlined: a function with a SET clause cannot be.
SELECT is((SELECT proconfig FROM pg_proc WHERE proname = 'tiles_for_geom'),
    ARRAY['jit=off'], 'which is what the SET clause is for');

SELECT * FROM finish();
ROLLBACK;
