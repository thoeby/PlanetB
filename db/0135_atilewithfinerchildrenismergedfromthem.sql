-- 0135_atilewithfinerchildrenismergedfromthem.sql — nothing is rendered twice
-- over the same ground.
--
-- `is_leaf_tile` (db/0045_coarseleaf.sql) has said `a_z >= 14 OR nothing is
-- under it`, so a z14 with sixteen published z16 children was still a leaf:
-- assembled, framed from forty-five stations and trained, describing ground its
-- own children already describe better. Two renders of one hillside, the
-- expensive one thrown away by the traversal the moment the children load
-- (client/js/traverse.js overlaps). A render is the costly thing this world
-- does; doing it twice is the one waste worth a migration on its own.
--
-- So the question is only ever the one the function's own comment asks —
-- "nothing finer exists on this ground" — and a parent with finer children is
-- what `merge` is for. Invariant 7 already anticipates this: merged tiles at
-- z <= 14 are deterministic and hash-verified, which is exactly what a z14 over
-- z16 children becomes.
--
-- The order that follows is the one SPEC §5.3 describes: the leaves publish
-- first, each publish marks its parent stale, and the parent is rebuilt from
-- what is under it. A parent whose children are not published yet simply has no
-- claimable merge (db/0035_mergeready.sql) and waits, which is correct — it has
-- nothing to say that its children will not say better.
CREATE OR REPLACE FUNCTION is_leaf_tile(a_z int, a_x int, a_y int) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT NOT EXISTS (
    SELECT 1 FROM tile c
    WHERE c.z = a_z + 2
      AND c.x BETWEEN a_x * 4 AND a_x * 4 + 3
      AND c.y BETWEEN a_y * 4 AND a_y * 4 + 3);
$$;
