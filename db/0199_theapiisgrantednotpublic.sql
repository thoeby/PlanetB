-- 0199_theapiisgrantednotpublic.sql — a function is executed by the roles it
-- is granted to, not by everybody.
--
-- Postgres grants EXECUTE to PUBLIC on every new function. Each api.* function
-- was also granted to the roles meant to call it, so PUBLIC was only ever the
-- door for everybody else: anon could call api.submit_verification or
-- api.set_ground and was stopped, if at all, by the uid check inside.
-- Invariant 6: what a caller may do is decided by grants and policies, not by
-- every function remembering to ask.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- revive_job (db/0081) resets a job's unfinished atoms and re-attempts its
-- publish, with no question about who asks. Only ensure_job and the pool's
-- own SECURITY DEFINER functions call it, as their owner; a player — and so
-- every QGIS login, which is a member of `player` connecting to the database
-- directly (db/0065) — never needs it.
REVOKE EXECUTE ON FUNCTION revive_job(bigint) FROM PUBLIC, player, admin;
