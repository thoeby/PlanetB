#!/usr/bin/env bash
# QGIS draws as you (db/0065_playerroles.sql).
#
# A pgTAP file is one session and `SET ROLE` is not the same thing as
# connecting: what has to be shown is that a real login, with a password and no
# token, is recognised as the player it belongs to and is held to exactly the
# rows that player may touch. So this connects.
set -euo pipefail

PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }
says () { case "$2" in *"$3"*) ok "$1";; *) no "$1 (said: $2)";; esac }

BEN=00000000-0000-0000-0000-00000000e001
CARA=00000000-0000-0000-0000-00000000e002

echo "player roles: a login of your own, and the same policies as the browser"

$PSQL <<SQL > /dev/null
INSERT INTO auth.user (id, email, pw_hash, role, name) VALUES
('$BEN', 'roles-ben@example.com', 'x', 'player', 'Ben'),
('$CARA', 'roles-cara@example.com', 'x', 'player', 'Cara')
ON CONFLICT (id) DO NOTHING;
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://127.0.0.1:8081/geoserver', 'test:visp',
        st_makeenvelope(7.8, 46.2, 7.95, 46.35, world_srid()), '$BEN');
DELETE FROM feature WHERE area_id IN
    (SELECT id FROM area WHERE owner_id IN ('$BEN', '$CARA'));
DELETE FROM area WHERE owner_id IN ('$BEN', '$CARA');
INSERT INTO area (geom, owner_id, detail) VALUES
(st_geomfromtext('POLYGON((7.876 46.291,7.883 46.291,7.883 46.296,'
                 '7.876 46.296,7.876 46.291))', world_srid()), '$BEN', 14),
(st_geomfromtext('POLYGON((7.860 46.280,7.868 46.280,7.868 46.286,'
                 '7.860 46.286,7.860 46.280))', world_srid()), '$CARA', 14);
SQL

creds () {
    $PSQL <<SQL
BEGIN;
SET LOCAL ROLE player;
SET LOCAL request.jwt.claims = '{"sub": "$1", "role": "player"}';
SELECT qgis_credentials(true) ->> '$2';
COMMIT;
SQL
}

ROLE=$(creds "$BEN" role)
PW=$(creds "$BEN" password)
is "the world minted Ben a login" "p_0000000000000000000000000000e001" "$ROLE"
[ ${#PW} -ge 32 ] && ok "with a password of its own" || no "password too short"

as_ben () { PGPASSWORD="$PW" psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
    -U "$ROLE" -d "${PGDATABASE:-splatworld}" --no-psqlrc -q -t -A "$@" 2>&1; }

is "a password session is Ben" "$BEN" "$(as_ben -c 'SELECT current_user_id()')"
is "and a player" "player" "$(as_ben -c 'SELECT current_user_role()')"

as_ben -c "INSERT INTO gis.f_forest (geom, leaf_type) VALUES (
    st_geomfromtext('MULTIPOLYGON(((7.878 46.292,7.880 46.292,7.880 46.294,
                     7.878 46.294,7.878 46.292)))', 4326), 'broadleaved')" > /dev/null
is "a forest drawn over a direct connection is Ben's" "$BEN" \
   "$($PSQL -c "SELECT a.owner_id FROM feature f JOIN area a ON a.id = f.area_id
                WHERE f.kind = 'forest' ORDER BY f.id DESC LIMIT 1")"
is "with the form's answer on it" "broadleaved" \
   "$($PSQL -c "SELECT props ->> 'leaf_type' FROM feature
                WHERE kind = 'forest' ORDER BY id DESC LIMIT 1")"

says "drawing on Cara's land says whose it is" \
     "$(as_ben -c "INSERT INTO gis.f_forest (geom) VALUES (
         st_geomfromtext('MULTIPOLYGON(((7.862 46.282,7.864 46.282,7.864 46.284,
                          7.862 46.284,7.862 46.282)))', 4326))")" \
     "Cara owns it"
says "drawing where nobody has land says so" \
     "$(as_ben -c "INSERT INTO gis.f_forest (geom) VALUES (
         st_geomfromtext('MULTIPOLYGON(((7.90 46.30,7.902 46.30,7.902 46.302,
                          7.90 46.302,7.90 46.30)))', 4326))")" \
     "not your land"
says "coordinates the wrong way round say so" \
     "$(as_ben -c "INSERT INTO gis.f_forest (geom) VALUES (
         st_geomfromtext('MULTIPOLYGON(((46.292 7.878,46.292 7.880,46.294 7.880,
                          46.294 7.878,46.292 7.878)))', 4326))")" \
     "longitude and latitude swapped"
says "land is assigned, not drawn" \
     "$(as_ben -c "INSERT INTO gis.area (geom, detail) VALUES (
         st_geomfromtext('MULTIPOLYGON(((7.90 46.30,7.91 46.30,7.91 46.31,
                          7.90 46.31,7.90 46.30)))', 4326), 14)")" \
     "permission denied"

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
