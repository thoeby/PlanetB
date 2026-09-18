-- 0136_onebudgetandarungforwalking.sql — one budget at every zoom, and z20.
--
-- The budgets were 800k at z14, 600k at z16 and 2M at z18. Each rung of the
-- ladder is a quarter of the last one's edge, so with a constant budget the
-- spacing improves exactly four times a rung. Ours went 1.89 m, 54.5 cm,
-- 7.5 cm — a 3.5x step and then a 7.3x one, because z18 carried more than
-- three times the splats of z16 for a sixteenth of its ground. z18 was
-- over-provisioned against its own ladder and z14 under it.
--
-- So: 600 000 everywhere, and the ladder is even.
--
--     z14  1.69 km   2.18 m
--     z16   423 m   54.5 cm
--     z18   106 m   13.6 cm
--     z20  26.4 m    3.4 cm
--
-- Every tile is then the same download, about 11 MB of planes, whatever zoom
-- it is — which is what makes a budget spent across tiles on screen
-- (client/js/traverse.js) mean the same thing wherever the camera is.
--
-- And z20, because 13.6 cm is scenery and 3.4 cm is something you can stand
-- next to. It is not a rung the world reaches by default: db/0089's rule still
-- holds, and a tile is only ever made as fine as what is earned on its ground.
-- A z20 is a twenty-six metre tile — 1 434 of them to a square kilometre — so
-- it is for where people actually go, not for ground in general.
--
-- Its stations are z16-v2's, which build_dag already picks for every zoom but
-- 18: forty-five eyes over a small tile is what a small tile needs.

ALTER DOMAIN zoom DROP CONSTRAINT zoom_check;
ALTER DOMAIN zoom ADD CONSTRAINT zoom_check CHECK (VALUE IN (6, 8, 10, 12, 14, 16, 18, 20));

ALTER TABLE area DROP CONSTRAINT area_detail_check;
ALTER TABLE area ADD CONSTRAINT area_detail_check CHECK (detail IN (10, 12, 14, 16, 18, 20));

-- One number, so the ladder is even and a tile is a tile.
CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT 600000::bigint;
$$;

-- z20 is framed from the same stations as z14 and z16 (db/0125).
CREATE OR REPLACE FUNCTION camera_views(z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z WHEN 18 THEN 120 WHEN 20 THEN 45 WHEN 16 THEN 45 WHEN 14 THEN 45 ELSE 0 END;
$$;
