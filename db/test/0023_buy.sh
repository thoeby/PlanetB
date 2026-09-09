#!/usr/bin/env bash
# WP4.4's acceptance: two concurrent buy_asset on the last edition, exactly one
# succeeds.
#
# A pgTAP file is one session, and one session cannot race itself: the edition
# lock is `UPDATE asset SET issued = issued + 1 WHERE issued < editions`, and
# what has to be shown is that a second transaction blocking on that row sees
# the committed count when it wakes. So this runs real parallel psql clients,
# the way db/test/0006_concurrency.sh does, and asserts the ledger and the
# rights afterwards.
#
# BUYERS clients all buy the same one-edition asset at the same moment. Exactly
# one right, exactly one ledger row, issued = 1.
set -euo pipefail

PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
BUYERS=${BUYERS:-16}
PASS=0
FAIL=0
ok () { echo "ok - $1"; PASS=$((PASS + 1)); }
no () { echo "not ok - $1"; FAIL=$((FAIL + 1)); }
is () { [ "$2" = "$3" ] && ok "$1" || no "$1 (expected $2, got $3)"; }

echo "buy_asset: ${BUYERS} clients racing for one edition"

# A digest of its own, so the SAN is this run's alone: the ledger is
# append-only, and a fixed asset would have every earlier run's buys still
# sitting under the same `buy:{san}:%` prefix.
STAMP=$(date +%s%N)
SHA=$(printf 'buy-race-%s' "$STAMP" | sha256sum | cut -d' ' -f1)

# ---------------------------------------------------------------- fixtures
$PSQL <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS buy_user, buy_err;
CREATE TABLE buy_user (n int PRIMARY KEY, uid uuid);
CREATE TABLE buy_err (n int, sqlstate text, msg text);

INSERT INTO buy_user (n, uid)
SELECT g, register('buyer' || g || '-${STAMP}@race.test', 'password12')
FROM generate_series(0, ${BUYERS}) g;

-- Everyone but the seller can afford exactly one copy.
INSERT INTO ledger (debit, credit, amount, ref)
SELECT treasury_account(),
       a.id, 100, 'seed:${STAMP}:' || u.n
FROM buy_user u JOIN account a ON a.owner_id = u.uid WHERE u.n > 0;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES ('${SHA}', 'glb', 2048, 'canon-v1') ON CONFLICT DO NOTHING;

DELETE FROM asset_right WHERE san = derive_san('${SHA}');
DELETE FROM asset WHERE san = derive_san('${SHA}');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, price, editions, creator_id)
VALUES (derive_san('${SHA}'), '${SHA}', 1, 'The last one', 'prop',
        '{"min":[0,0,0],"max":[1,1,1]}'::jsonb, 12, 0, 'limited', 10, 1,
        (SELECT uid FROM buy_user WHERE n = 0));
SQL

SAN=$($PSQL -c "SELECT derive_san('${SHA}')")
START=$(date -d '+2 seconds' +%s)

# --------------------------------------------------------------------- race
# Every client spins until the same wall-clock second, then buys. Failures are
# recorded rather than raised: exactly one of them is meant to succeed.
buyer () {
    local n=$1
    $PSQL <<SQL 2> /dev/null || true
DO \$\$
DECLARE
    uid uuid;
BEGIN
    SELECT u.uid INTO uid FROM buy_user u WHERE u.n = ${n};
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', uid, 'role', 'player')::text, false);
    WHILE extract(epoch FROM clock_timestamp()) < ${START} LOOP
    END LOOP;
    BEGIN
        PERFORM buy_asset('${SAN}');
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO buy_err (n, sqlstate, msg) VALUES (${n}, SQLSTATE, SQLERRM);
    END;
END \$\$;
SQL
}

for n in $(seq 1 "$BUYERS"); do buyer "$n" & done
wait

# ------------------------------------------------------------------ asserts
is "exactly one buyer holds a right" 1 \
   "$($PSQL -c "SELECT count(*) FROM asset_right WHERE san = '${SAN}'")"
is "the asset issued exactly one edition" 1 \
   "$($PSQL -c "SELECT issued FROM asset WHERE san = '${SAN}'")"
is "exactly one buy went into the ledger" 1 \
   "$($PSQL -c "SELECT count(*) FROM ledger WHERE ref LIKE 'buy:${SAN}:%'")"
is "every other buyer was told it is sold out" "$((BUYERS - 1))" \
   "$($PSQL -c "SELECT count(*) FROM buy_err WHERE sqlstate = 'PT409'")"
is "and nobody failed for any other reason" 0 \
   "$($PSQL -c "SELECT count(*) FROM buy_err WHERE sqlstate <> 'PT409'")"
is "the seller was paid once" 10 \
   "$($PSQL -c "SELECT coalesce(sum(amount), 0)::int FROM ledger
                WHERE ref LIKE 'buy:${SAN}:%'")"
is "and the holder paid for it" -10 \
   "$($PSQL -c "SELECT coalesce(sum(CASE WHEN l.debit = a.id THEN -l.amount ELSE l.amount END), 0)::int
                FROM ledger l
                JOIN asset_right r ON r.san = '${SAN}'
                JOIN account a ON a.owner_id = r.holder_id
                WHERE l.ref LIKE 'buy:${SAN}:%'")"

$PSQL -c 'DROP TABLE IF EXISTS buy_user, buy_err' > /dev/null
echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
