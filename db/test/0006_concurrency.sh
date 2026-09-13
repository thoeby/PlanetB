#!/usr/bin/env bash
# WP0.7 — concurrency torture test.
# 32 workers claim/heartbeat/submit over 500 ready atoms while 4 clients edit
# features underneath them and 2 clients publish stale versions. Afterwards:
# no atom claimed twice, no duplicate ledger.ref, every stale publish returned
# false, published_version <= expected_version everywhere, no deadlocks.
set -euo pipefail

PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"
WORKERS=${WORKERS:-32}
EDITORS=${EDITORS:-4}
ITERS=${ITERS:-60}
TILES=${TILES:-500}

echo "concurrency: ${WORKERS} workers, ${EDITORS} editors, 2 stale publishers"

# ---------------------------------------------------------------- fixtures
$PSQL <<SQL
SET client_min_messages = warning;
DROP TABLE IF EXISTS claim_log, publish_log, err_log, torture_user;

CREATE TABLE claim_log (atom_id bigint, worker_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE publish_log (z int, x int, y int, target_version bigint, stale bool, ok bool);
CREATE TABLE err_log (who text, sqlstate text, msg text, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE torture_user (n int PRIMARY KEY, uid uuid);

CREATE FUNCTION log_claim() RETURNS trigger LANGUAGE plpgsql AS \$\$
BEGIN
    INSERT INTO claim_log (atom_id, worker_id) VALUES (new.id, new.worker_id);
    RETURN NULL;
END \$\$;
CREATE TRIGGER atom_claim_log AFTER UPDATE ON atom
FOR EACH ROW WHEN (new.state = 'claimed' AND old.state IS DISTINCT FROM 'claimed')
EXECUTE FUNCTION log_claim();

INSERT INTO torture_user (n, uid)
SELECT g, register('w' || g || '@torture.test', 'password12')
FROM generate_series(0, ${WORKERS} + ${EDITORS}) g;

-- One area wide enough to hold a ${TILES}-tile block of z14, owned by user 0.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid,
       st_makeenvelope(7.0, 46.0, 8.2, 46.9, 4326),
       uid, 14
FROM torture_user WHERE n = 0;

-- One feature per z14 tile: ${TILES} distinct tiles, each with its own job.
INSERT INTO feature (area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000a1',
       'footprint',
       st_force3d(st_centroid(tile_bbox(14, x, y)))
FROM generate_series(tile_x(7.05, 14), tile_x(7.05, 14) + 24) AS x,
     generate_series(tile_y(46.85, 14), tile_y(46.85, 14) + 19) AS y;

DO \$\$
DECLARE
    r record;
    i int := 0;
BEGIN
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', uid, 'role', 'player')::text, true)
    FROM torture_user WHERE n = 0;
    PERFORM transfer(treasury_account(),
        (SELECT id FROM account WHERE owner_id = tu.uid), 100000, 'seed:torture')
    FROM torture_user tu WHERE tu.n = 0;
    -- Every fifth job carries a bounty, so the ledger is written concurrently too.
    FOR r IN SELECT x, y FROM tile WHERE z = 14 ORDER BY x, y LOOP
        i := i + 1;
        PERFORM ensure_job(14, r.x, r.y, CASE WHEN i % 5 = 0 THEN 1 ELSE 0 END);
    END LOOP;
END \$\$;
SQL

READY=$($PSQL -c "SELECT count(*) FROM atom WHERE state = 'ready'")
echo "seeded ${READY} ready atoms"

# ---------------------------------------------------------------- procedures
$PSQL <<'SQL'
CREATE PROCEDURE torture_worker(p_n int, p_iters int)
LANGUAGE plpgsql AS $$
DECLARE
    p_user uuid := (SELECT uid FROM torture_user WHERE n = p_n);
    a     atom%rowtype;
    j     job%rowtype;
    sha   text;
    st    text;
    res   boolean;
    idle  int := 0;
BEGIN
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_user, 'role', 'player')::text, false);
    FOR i IN 1..p_iters LOOP
        BEGIN
            SELECT * INTO a FROM claim_atom('{"webgpu": true, "vram_gb": 8}'::jsonb);
            IF a.id IS NULL THEN
                idle := idle + 1;
                PERFORM pg_sleep(0.1);
            ELSE
                idle := 0;
                sha := encode(digest('out:' || a.atom_hash, 'sha256'), 'hex');
                PERFORM register_artifact(sha,
                    CASE a.op WHEN 'sog' THEN 'sog' ELSE 'ply' END, 1024, a.algo_version);
                PERFORM heartbeat(a.id);
                st := submit_atom(a.id, sha, jsonb_build_object(
                    'splat_count', 1000, 'finite', true, 'gpu_seconds', 1,
                    -- db/0015_structural.sql: a splat-producing op says where
                    -- its splats are, and a metre from the middle is inside
                    -- every tile there is.
                    'bbox', jsonb_build_array(-1, -1, -1, 1, 1, 1)));
                IF a.op = 'sog' AND st = 'verified' THEN
                    SELECT * INTO j FROM job WHERE id = a.job_id;
                    res := publish_tile(j.z, j.x, j.y, j.target_version, sha, '{}'::jsonb);
                    INSERT INTO publish_log VALUES (j.z, j.x, j.y, j.target_version, false, res);
                END IF;
            END IF;
        EXCEPTION WHEN others THEN
            idle := 0;
            INSERT INTO err_log (who, sqlstate, msg) VALUES ('worker', sqlstate, sqlerrm);
        END;
        COMMIT;
        EXIT WHEN idle >= 10;
    END LOOP;
END $$;

CREATE PROCEDURE torture_editor(p_n int, p_iters int)
LANGUAGE plpgsql AS $$
BEGIN
    FOR i IN 1..p_iters LOOP
        BEGIN
            UPDATE feature SET props = jsonb_build_object('n', i)
            WHERE id IN (SELECT id FROM feature ORDER BY random() LIMIT 3);
        EXCEPTION WHEN others THEN
            INSERT INTO err_log (who, sqlstate, msg) VALUES ('editor', sqlstate, sqlerrm);
        END;
        COMMIT;
    END LOOP;
END $$;

-- Publishes a version this worker really produced but which the world has
-- already moved past. Every one of these must return false (Invariant 3).
CREATE PROCEDURE torture_stale(p_n int, p_iters int)
LANGUAGE plpgsql AS $$
DECLARE
    p_user uuid := (SELECT uid FROM torture_user WHERE n = p_n);
    r   record;
    res boolean;
BEGIN
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_user, 'role', 'player')::text, false);
    FOR i IN 1..p_iters LOOP
        BEGIN
            SELECT j.z, j.x, j.y, j.target_version, a.output_sha256 INTO r
            FROM atom a
            JOIN job j ON j.id = a.job_id
            JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
            JOIN worker w ON w.id = a.worker_id AND w.user_id = p_user
            WHERE a.op = 'sog' AND a.state = 'verified'
              AND j.target_version < t.expected_version
            LIMIT 1;
            IF r.z IS NOT NULL THEN
                res := publish_tile(r.z, r.x, r.y, r.target_version,
                                    r.output_sha256, '{}'::jsonb);
                INSERT INTO publish_log VALUES (r.z, r.x, r.y, r.target_version, true, res);
            ELSE
                -- nothing stale to attempt yet; stay alive for the workers
                PERFORM pg_sleep(0.2);
            END IF;
        EXCEPTION WHEN others THEN
            INSERT INTO err_log (who, sqlstate, msg) VALUES ('stale', sqlstate, sqlerrm);
        END;
        COMMIT;
    END LOOP;
END $$;
SQL

DEADLOCKS_BEFORE=$($PSQL -c "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()")

# ---------------------------------------------------------------------- run
pids=()
for n in $(seq 1 "$WORKERS"); do
    $PSQL -c "CALL torture_worker($n, $ITERS)" &
    pids+=($!)
done
for n in $(seq $((WORKERS + 1)) $((WORKERS + EDITORS))); do
    $PSQL -c "CALL torture_editor($n, $ITERS)" &
    pids+=($!)
done
for n in 1 2; do
    $PSQL -c "CALL torture_stale($n, $ITERS)" &
    pids+=($!)
done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=1; done
[ "$fail" -eq 0 ] || { echo "not ok - a client exited non-zero"; exit 1; }

# A guaranteed stale publish: move the world past a tile that has already been
# published, then let the very worker that produced it try its old version.
# Since db/0069_approvalverbs.sql what lands is published outright — the
# approval came before the render — and the compare-and-swap it has to win is
# unchanged (Invariant 3).
$PSQL <<'SQL'
DO $$
DECLARE
    r   record;
    res boolean;
BEGIN
    SELECT j.z, j.x, j.y, j.target_version, a.output_sha256, w.user_id INTO r
    FROM atom a
    JOIN job j ON j.id = a.job_id
    JOIN worker w ON w.id = a.worker_id
    JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a.op = 'sog' AND a.state = 'verified'
      AND t.published_version = j.target_version
    LIMIT 1;
    IF r.z IS NULL THEN
        RAISE EXCEPTION 'no tile has been published to probe';
    END IF;
    UPDATE feature SET props = '{"probe": true}'::jsonb
    WHERE st_intersects(geom, tile_bbox(r.z, r.x, r.y));
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', r.user_id, 'role', 'player')::text, true);
    res := publish_tile(r.z, r.x, r.y, r.target_version, r.output_sha256, '{}'::jsonb);
    INSERT INTO publish_log VALUES (r.z, r.x, r.y, r.target_version, true, res);
END $$;
SQL

# ------------------------------------------------------------------ audit
DEADLOCKS_AFTER=$($PSQL -c "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()")

check () { # name expected actual
    if [ "$2" = "$3" ]; then
        echo "ok - $1"
    else
        echo "not ok - $1 (expected $2, got $3)"
        FAILED=1
    fi
}
FAILED=0

check "no atom was claimed twice" 0 \
    "$($PSQL -c "SELECT count(*) FROM (SELECT atom_id FROM claim_log GROUP BY atom_id HAVING count(*) > 1) d")"
check "every claim_log row names a worker" 0 \
    "$($PSQL -c "SELECT count(*) FROM claim_log WHERE worker_id IS NULL")"
check "no duplicate ledger.ref" 0 \
    "$($PSQL -c "SELECT count(*) - count(DISTINCT ref) FROM ledger")"
check "every stale publish returned false" 0 \
    "$($PSQL -c "SELECT count(*) FROM publish_log WHERE stale AND ok")"
check "stale publishes were actually attempted" t \
    "$($PSQL -c "SELECT count(*) > 0 FROM publish_log WHERE stale")"
check "published_version <= expected_version everywhere" 0 \
    "$($PSQL -c "SELECT count(*) FROM tile WHERE published_version > expected_version")"
check "no version was published twice" 0 \
    "$($PSQL -c "SELECT count(*) FROM (SELECT z, x, y, target_version FROM publish_log WHERE ok GROUP BY 1,2,3,4 HAVING count(*) > 1) d")"
check "no deadlocks" "$DEADLOCKS_BEFORE" "$DEADLOCKS_AFTER"
check "no atom is stuck claimed" 0 \
    "$($PSQL -c "SELECT count(*) FROM atom WHERE state = 'claimed' AND heartbeat_at < now() - interval '5 minutes'")"
check "escrow settled to zero" 0 \
    "$($PSQL -c "SELECT count(*) FROM (SELECT 1 WHERE account_balance(escrow_account()) <> (SELECT coalesce(sum(bounty),0) FROM job WHERE state = 'open')) d")"

echo "claims: $($PSQL -c 'SELECT count(*) FROM claim_log'), \
publishes: $($PSQL -c 'SELECT count(*) FROM publish_log WHERE ok'), \
stale attempts: $($PSQL -c 'SELECT count(*) FROM publish_log WHERE stale'), \
errors: $($PSQL -c 'SELECT count(*) FROM err_log')"
$PSQL -c "SELECT who || ' ' || sqlstate || ' x' || count(*) || ' ' || left(min(msg), 80) FROM err_log GROUP BY who, sqlstate"

exit "$FAILED"
