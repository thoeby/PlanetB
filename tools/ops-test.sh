#!/usr/bin/env bash
# WP5.5 — the ops gate, and the restore drill run for real on every gate.
#
# A scratch database, a scratch store and a scratch backup root: a drill that
# needs the developer's own world is a drill nobody runs, and the one thing this
# must never do is delete bytes somebody still points at.
#
# What it asserts: that a backup holds both halves and not the scratch half;
# that a database dropped on the floor comes back from the dump alone; that a
# store that has lost bytes is filled in without overwriting the ones it kept;
# and that gc-jobs can tell a finished job's leftovers from a live job's input,
# including the dedup case where they sit in the same directory.
set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }

PSQL_Q="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
SCRATCH_DB=splatworld_ops_$$
export FILES_ROOT; FILES_ROOT=$(mktemp -d)
export BACKUP_ROOT; BACKUP_ROOT=$(mktemp -d)

cleanup () {
    PGDATABASE=postgres $PSQL_Q -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" \
        > /dev/null 2>&1
    # db/0007_api.sql's ALTER ROLE is cluster-wide (tools/seed-ch-test.sh says
    # why): put the password back the way the developer's PostgREST expects it.
    PGDATABASE=postgres $PSQL_Q -c "ALTER ROLE authenticator PASSWORD\
 '${AUTHENTICATOR_PASSWORD:-authenticator}'" > /dev/null 2>&1 || true
    rm -rf "$FILES_ROOT" "$BACKUP_ROOT"
}
PGDATABASE=postgres $PSQL_Q -c 'SELECT 1' > /dev/null 2>&1 \
    || { echo "not ok - no database at ${PGHOST:-localhost}:${PGPORT:-5432}"; exit 1; }
command -v pg_dump > /dev/null && command -v pg_restore > /dev/null \
    || { echo "not ok - pg_dump and pg_restore are what a backup is"; exit 1; }
PGDATABASE=postgres $PSQL_Q -c "CREATE DATABASE $SCRATCH_DB" > /dev/null
trap cleanup EXIT
export PGDATABASE=$SCRATCH_DB
$PSQL_Q -c 'CREATE EXTENSION IF NOT EXISTS postgis' \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' > /dev/null
for f in db/[0-9]*.sql; do
    psql -v ON_ERROR_STOP=1 --no-psqlrc -q -v authpw="${AUTHENTICATOR_PASSWORD:-authenticator}" \
        -v geopw="${GEOSERVER_DB_PASSWORD:-geoserver}" -f "$f" > /dev/null 2>&1 \
        || { echo "not ok - $f would not apply to $SCRATCH_DB"; exit 1; }
done
echo "# ops-test: $SCRATCH_DB, store $FILES_ROOT, backups $BACKUP_ROOT"

# ------------------------------------------------------------------- a world

# A published tile, an asset somebody uploaded, a job that finished a month ago
# and one that is still open — and, deliberately, an input the open job names
# that lives in the finished job's directory. That is the dedup case: an
# artifact is written once, so the second atom to produce those bytes records
# somebody else's path (client/js/work.js).
SQL=$(mktemp); trap 'rm -f "$SQL"; cleanup' EXIT
cat > "$SQL" <<'BLOCK'
SET client_min_messages = warning;
DO $w$
DECLARE
    uid  uuid;
    old  bigint;
    new  bigint;
    a1   bigint;
    a2   bigint;
BEGIN
    uid := register('ops@splatworld.local', 'ops-pw-not-a-login');
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', uid, 'role', 'admin')::text, true);
    INSERT INTO artifact (sha256, kind, bytes, algo_version, created_by) VALUES
        (repeat('a', 64), 'sog', 10, 'sog-v1', uid),
        (repeat('b', 64), 'ply', 10, 'merge-v1', uid),
        (repeat('c', 64), 'glb', 10, 'canon-v1', uid),
        (repeat('d', 64), 'ply', 10, 'merge-v1', uid);
    INSERT INTO tile (z, x, y, dirty, expected_version, published_version, sog_sha256)
    VALUES (14, 4242, 4242, false, 1, 1, repeat('a', 64));
    INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
        tex_bytes, license, price, creator_id)
    VALUES ('SOPSOPSOPSOPS', repeat('c', 64), 1, 'ops', 'furniture',
        '{}'::jsonb, 1, 0, 'cc0', 0, uid);

    INSERT INTO job (z, x, y, target_version, state, created_at)
    VALUES (14, 4242, 4242, 1, 'done', now() - interval '30 days') RETURNING id INTO old;
    INSERT INTO atom (job_id, atom_hash, op, algo_version, inputs, params, state,
        output_sha256, claimed_at, heartbeat_at)
    VALUES (old, repeat('1', 64), 'merge', 'merge-v1', '{}', '{}', 'verified',
        repeat('b', 64), now() - interval '30 days', now() - interval '30 days')
    RETURNING id INTO a1;

    INSERT INTO job (z, x, y, target_version, state)
    VALUES (14, 4242, 4242, 2, 'open') RETURNING id INTO new;
    INSERT INTO atom (job_id, atom_hash, op, algo_version, inputs, params, state,
        output_sha256, result)
    VALUES (new, repeat('2', 64), 'merge', 'merge-v1', '{}', '{}', 'verified',
        repeat('d', 64),
        jsonb_build_object('path', '/jobs/' || a1 || '/' || repeat('d', 64) || '.ply'))
    RETURNING id INTO a2;
    RAISE NOTICE 'ops-test atoms % %', a1, a2;
END
$w$;
BLOCK
$PSQL_Q -f "$SQL" > /dev/null

OLD=$($PSQL_Q -c "SELECT a.id FROM atom a JOIN job j ON j.id = a.job_id
                  WHERE j.state = 'done' ORDER BY a.id LIMIT 1")
NEW=$($PSQL_Q -c "SELECT a.id FROM atom a JOIN job j ON j.id = a.job_id
                  WHERE j.state = 'open' ORDER BY a.id LIMIT 1")
mkdir -p "$FILES_ROOT/assets" "$FILES_ROOT/tiles/14/4242/4242" \
    "$FILES_ROOT/jobs/$OLD" "$FILES_ROOT/jobs/$NEW"
ASSET=$FILES_ROOT/assets/$(printf 'c%.0s' {1..64}).glb
# The path publish_tile's worker writes: /tiles/{z}/{x}/{y}/{sha}.sog.
TILE=$FILES_ROOT/tiles/14/4242/4242/$(printf 'a%.0s' {1..64}).sog
DEAD=$FILES_ROOT/jobs/$OLD/$(printf 'b%.0s' {1..64}).ply
SHARED=$FILES_ROOT/jobs/$OLD/$(printf 'd%.0s' {1..64}).ply
head -c 4096 /dev/urandom > "$ASSET"
head -c 4096 /dev/urandom > "$TILE"
head -c 2048 /dev/urandom > "$DEAD"
head -c 2048 /dev/urandom > "$SHARED"
head -c 2048 /dev/urandom > "$FILES_ROOT/jobs/$NEW/scratch.ply"
touch -d '30 days ago' "$DEAD" "$SHARED" "$FILES_ROOT/jobs/$NEW/scratch.ply"

# -------------------------------------------------------------------- backup

bash tools/backup.sh "$BACKUP_ROOT" > /dev/null
DEST=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
[ -s "$DEST/db.dump" ] && ok "the dump is written" || no "the dump is written"
is "the assets are copied" 1 "$(find "$DEST/files/assets" -type f | wc -l)"
is "and the published tiles" 1 "$(find "$DEST/files/tiles" -type f | wc -l)"
is "and /jobs is not, because it is scratch" 0 \
    "$(find "$DEST/files" -path '*jobs*' -type f | wc -l)"
grep -q '^order' "$DEST/manifest.txt" && ok "the manifest says what was taken and how" \
    || no "the manifest says what was taken and how"

# ------------------------------------------------------------------- restore

# The drill. The world is destroyed both ways at once — the database dropped and
# the store's bytes deleted — and put back from the backup alone.
sums=$(sha256sum "$ASSET" "$TILE" | awk '{print $1}' | sort)
PGDATABASE=postgres $PSQL_Q -c "DROP DATABASE $SCRATCH_DB WITH (FORCE)" > /dev/null
rm -f "$ASSET" "$TILE"
out=$(JWT_SECRET=${JWT_SECRET:-dev-secret-change-me-0123456789abcdef} \
    bash tools/restore.sh "$DEST" 2>&1) \
    && ok "the drill: a dropped database and an emptied store come back" \
    || no "the drill: a dropped database and an emptied store come back ($out)"
is "and the bytes are the bytes that were backed up" "$sums" \
    "$(sha256sum "$ASSET" "$TILE" 2>/dev/null | awk '{print $1}' | sort)"
is "the tile still points at its sog" "$(printf 'a%.0s' {1..64})" \
    "$($PSQL_Q -c 'SELECT sog_sha256 FROM tile WHERE z = 14')"
is "and the drift check is clean" 0 \
    "$(bash tools/restore.sh --check 2>&1 | sed -n 's/.* \([0-9]*\) of them missing.*/\1/p')"

# A restore never overwrites: a file already in the store keeps the bytes its
# name says it holds (Invariant 1).
printf 'not the backup' > "$ASSET"
bash tools/restore.sh "$DEST" --files-only > /dev/null 2>&1
is "a restore fills in, it does not overwrite" "not the backup" "$(cat "$ASSET")"
head -c 4096 /dev/urandom > "$ASSET"

# ------------------------------------------------------------------- gc-jobs

out=$(bash tools/gc-jobs.sh)
is "gc-jobs deletes nothing unless told to" 3 \
    "$(find "$FILES_ROOT/jobs" -type f | wc -l)"
grep -qi 'apply' <<< "$out" && ok "and says how to tell it to" \
    || no "and says how to tell it to (said: $out)"

bash tools/gc-jobs.sh --apply > /dev/null
[ -f "$DEAD" ] && no "the finished job's own leftovers go" || ok "the finished job's own leftovers go"
[ -f "$SHARED" ] && ok "an input a live job names does not, wherever it sits" \
    || no "an input a live job names does not, wherever it sits"
[ -f "$FILES_ROOT/jobs/$NEW/scratch.ply" ] && ok "and neither does the live job's own" \
    || no "and neither does the live job's own"
is "nothing outside /jobs was touched" 2 \
    "$(find "$FILES_ROOT/assets" "$FILES_ROOT/tiles" -type f | wc -l)"

# ---------------------------------------------------------------- rate limit

# infra/nginx.conf limits PUT. The numbers are read out of the config rather
# than repeated here, so re-tuning the limit re-tunes the test with it.
#
# Its own nginx on its own port, never the shared store: the second burst below
# is meant to exhaust the bucket, and doing that to a store another test is
# using would rate-limit that test instead. The upstream is pointed at a dead
# port on purpose — ngx_http_limit_req runs in the preaccess phase, ahead of
# auth_request, so what can_write would have answered cannot affect the count.
if ! command -v nginx > /dev/null; then
    echo '# no nginx binary, the PUT rate limit was not exercised'
else
    BURST=$(sed -n 's/.*limit_req .*burst=\([0-9]*\).*/\1/p' infra/nginx.conf)
    RATE=$(sed -n 's/.*limit_req_zone .*rate=\([0-9]*\)r\/s.*/\1/p' infra/nginx.conf)
    [ -n "$BURST" ] && [ -n "$RATE" ] \
        && ok "infra/nginx.conf limits PUT: $RATE r/s, burst $BURST" \
        || no "infra/nginx.conf limits PUT"

    PORT=${OPS_FILES_PORT:-8085}
    WORK=$(mktemp -d); chmod 1777 "$WORK"
    CONF=$WORK/nginx.conf
    sed -e "s|server postgrest:3000;|server 127.0.0.1:3999;|" \
        -e "s|listen 80;|listen $PORT;|" -e "s|root /srv/files;|root $WORK;|" \
        -e "1i pid $WORK/nginx.pid;\nerror_log $WORK/error.log;" \
        -e "s|^http {|http {\n    access_log $WORK/access.log;\n    client_body_temp_path $WORK/body;\n    proxy_temp_path $WORK/proxy;\n    fastcgi_temp_path $WORK/fcgi;\n    uwsgi_temp_path $WORK/uwsgi;\n    scgi_temp_path $WORK/scgi;|" \
        infra/nginx.conf > "$CONF"
    nginx -c "$CONF"
    trap 'nginx -c "$CONF" -s quit 2> /dev/null; rm -rf "$WORK"; rm -f "$SQL"; cleanup' EXIT
    for _ in $(seq 1 20); do
        curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.25
    done

    puts () { # n -> one http code per line, as fast as one curl can ask
        local n=$1 i args=(-s -w '%{http_code}\n')
        for i in $(seq 1 "$n"); do
            args+=(-o /dev/null "http://127.0.0.1:$PORT/jobs/1/x$i")
        done
        curl -X PUT "${args[@]}"
    }
    is "a burst of $((BURST - 10)) PUTs is never limited" 0 \
        "$(puts $((BURST - 10)) | grep -c 429 || true)"
    [ "$(puts $((BURST * 3)) | grep -c 429 || true)" -gt 0 ] \
        && ok "and a client that will not stop is" \
        || no "and a client that will not stop is"
fi

echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
