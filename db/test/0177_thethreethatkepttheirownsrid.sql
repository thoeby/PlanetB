-- No function body in this world writes an SRID down (db/0056, db/0177).
BEGIN;
SELECT plan(1);

SET client_min_messages = warning;

-- The three db/0169 and db/0172 were corrected in place, which does nothing
-- for a database that applied them before the correction.
SELECT is((SELECT count(*)::int FROM pg_proc p
           INNER JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('live_near', 'mover_set', 'movers_near')
             AND pg_get_functiondef(p.oid) ~ '4326'), 0,
    'the three that kept their own SRID have it no longer');

-- The rule over everything else is server/test_crs_agree.py, which reads every
-- applied body and knows that a typmod is not a choice made at run time.
SELECT * FROM finish();
ROLLBACK;
