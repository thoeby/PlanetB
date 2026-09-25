-- 0217_whatnobodycallsisgone.sql — functions no page, tool or other function
-- calls any more, dropped rather than left granted.
--
-- approve_tile, refuse_tile and my_candidates were the candidate step of
-- db/0044: a rendered tile waited for its owner to publish it. Approval moved
-- before rendering (db/0068, db/0069) and a tile publishes as it lands. Their
-- may_approve_tile stays, ungranted: db/0060 re-creates my_candidates over it,
-- and `splatworld run` replays old files on a database older than its ledger.
-- height_edit_rev (db/0163) was the sculpt panel's revision check; the panel
-- reads the edit itself. inside_ground (db/0062) was folded into
-- refuse_outside_ground (db/0140), which no longer calls it.
DROP FUNCTION IF EXISTS api.approve_tile(int, int, int);
DROP FUNCTION IF EXISTS approve_tile(int, int, int);
DROP FUNCTION IF EXISTS api.refuse_tile(int, int, int, text);
DROP FUNCTION IF EXISTS refuse_tile(int, int, int, text);
DROP FUNCTION IF EXISTS api.my_candidates(float8, float8, int);
DROP FUNCTION IF EXISTS my_candidates(float8, float8, int);
REVOKE EXECUTE ON FUNCTION may_approve_tile(int, int, int) FROM PUBLIC, anon, player, admin;
DROP FUNCTION IF EXISTS api.height_edit_rev(uuid);
DROP FUNCTION IF EXISTS height_edit_rev(uuid);
DROP FUNCTION IF EXISTS inside_ground(geometry);
