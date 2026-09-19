#!/usr/bin/env bash
# db/0110 — two sessions ask for the same tile at the same version at the same
# moment. One job is opened, both are handed it, and neither transaction dies:
# before this, the loser hit job_z_x_y_target_version_key and took whatever it
# was part of — an approval, a publish, the ladder above it — down with it.
set -euo pipefail

PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

$PSQL > /dev/null <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS race_user;
CREATE TABLE race_user (uid uuid);
INSERT INTO race_user
SELECT coalesce((SELECT id FROM auth.user WHERE email = 'race110@example.test'),
                register('race110@example.test', 'password12'));
DELETE FROM feature WHERE area_id = '00000000-0000-0000-0000-000000000110';
DELETE FROM area WHERE id = '00000000-0000-0000-0000-000000000110';
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000110'::uuid,
       st_geomfromtext('POLYGON((7.80 46.29,7.81 46.29,7.81 46.30,7.80 46.30,7.80 46.29))',
                       4326),
       uid, 14 FROM race_user;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000110', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, false) FROM race_user;
SELECT recompile_land('00000000-0000-0000-0000-000000000110');
SQL

X=$($PSQL -c "SELECT tile_x(7.805, 14)")
Y=$($PSQL -c "SELECT tile_y(46.295, 14)")

# One holds the insert open; the other walks into it a second later.
ask() { # $1 file, $2 seconds to hold the transaction open
    $PSQL > "$1" 2>&1 <<SQL || true
BEGIN;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM race_user;
SELECT ensure_job(14, $X, $Y);
SELECT pg_sleep($2);
COMMIT;
SQL
}
ask "$OUT/a" 3 &
sleep 1
ask "$OUT/b" 0 &
wait

FAILED=0
check() {
    if [ "$2" = "$3" ]; then echo "ok - $1"; else
        echo "not ok - $1 (want '$2', got '$3')"; FAILED=1; fi
}
# the job id each session was handed: the one bare number it printed
A=$(grep -m1 -E '^[0-9]+$' "$OUT/a" || true)
B=$(grep -m1 -E '^[0-9]+$' "$OUT/b" || true)
check "neither session errored" "" "$(grep -h '^ERROR' "$OUT/a" "$OUT/b" | head -1)"
check "both were handed the same job" "$A" "$B"
check "and only one job was opened for that version" 1 \
    "$($PSQL -c "SELECT count(*) FROM job WHERE z = 14 AND x = $X AND y = $Y
                  AND target_version = (SELECT expected_version FROM tile
                                        WHERE z = 14 AND x = $X AND y = $Y)")"
check "the job has its atoms" t \
    "$($PSQL -c "SELECT count(*) > 0 FROM atom WHERE job_id = $A")"
$PSQL -c "DROP TABLE race_user" > /dev/null
exit "$FAILED"
