-- Merge readiness fix for claim_for()
--
-- The existing claim_for() function must apply this predicate when selecting
-- a ready atom:
--
--   AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
--
-- This migration file is accompanied by the directly patched 0043_pool.sql.
-- Apply the patched function definition from 0043_pool.sql when migrations are
-- deployed to an existing database.

-- No-op marker migration: the functional change is the predicate above.
SELECT 1;
