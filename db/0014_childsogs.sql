-- 0014_childsogs.sql — child_sogs() never found a child.
--
-- Its parameters are named z, x and y, and its body compares them against a
-- `tile t` in the same scope. In a SQL-language function a bare name that
-- matches a column of a table in scope resolves to the column, so
-- `t.z = z + 2` was `t.z = t.z + 2`: false for every row, sixteen empty
-- strings, and a merge atom whose inputs named no children at all.
--
-- The same trap cost WP0.6 the merge atom's identity (db/0009_atomid.sql) and
-- is documented in HANDOFF.md; qualifying every parameter is the fix. Nothing
-- else in the function changes, and the atom hash it feeds still pins the exact
-- set of children a merge was built from (Invariant 2).

CREATE OR REPLACE FUNCTION child_sogs(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s), '[]'::jsonb)
FROM (
    SELECT coalesce(
        (SELECT t.sog_sha256 FROM tile t
         WHERE t.z = child_sogs.z + 2
           AND t.x = child_sogs.x * 4 + dx
           AND t.y = child_sogs.y * 4 + dy),
        '') AS s
    FROM generate_series(0, 3) dx, generate_series(0, 3) dy
) c;
$$;
