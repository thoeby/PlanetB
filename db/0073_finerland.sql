-- 0073_finerland.sql — more splats in a tile that is not trained.
--
-- A z14 tile is about 1.7 km across at Alpine latitudes, and 800 000 splats
-- over it is one splat per three and a half square metres: from standing height
-- that is the ground as a smear. z16 and z18 are the answer for anything you
-- walk up to (SPEC §0.1, `area.detail`), and they are trained, which needs a
-- GPU in whichever tab takes the job. What z14 is for is everything you see
-- from further away, and it can afford to be denser: the op that makes it is
-- `sample`, which scatters points over the assembled surface — no training, no
-- GPU, and the cost is the file and the time to write it.
--
-- Invariant 2 holds: a budget is an atom's param, so every atom already built
-- keeps the number it was built with. Tiles compiled before this keep their
-- splats until something dirties them and a new job is opened.
CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z
    WHEN 18 THEN 2000000 WHEN 16 THEN 600000 WHEN 14 THEN 2000000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END::bigint;
$$;
