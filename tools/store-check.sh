#!/usr/bin/env bash
# store-check.sh — every artifact the database registers, asked of the store.
#
# The database says a file exists (artifact, db/0166 path) and the store is
# what has it. They come apart when one is emptied and the other is not —
# `splatworld init --reset` drops the database and leaves infra/files; wiping
# infra/files leaves the rows — and a tab then meets "registered but nowhere
# in the store" (client/js/upload.js). This says which rows those are. It
# deletes nothing: the rows to drop are printed as SQL for a person to read
# and run, because a row another table still points at is refused anyway.
#
#   FILES_URL=http://localhost:8080 tools/store-check.sh
set -euo pipefail

FILES_URL=${FILES_URL:-http://localhost:8080}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A"

missing=0; unlocated=0; ok=0
while IFS='|' read -r sha kind path; do
    if [ -z "$path" ]; then
        unlocated=$((unlocated + 1))
        echo "unlocated  $sha  $kind  (registered before db/0166, no address)"
        continue
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -I "$FILES_URL$path")
    if [ "$code" = "200" ]; then
        ok=$((ok + 1))
    else
        missing=$((missing + 1))
        echo "missing    $sha  $kind  $path  ($code)"
        echo "  DELETE FROM artifact WHERE sha256 = '$sha';"
    fi
done < <($PSQL -c "SELECT sha256, kind, coalesce(path, '') FROM artifact ORDER BY created_at")

echo "store-check: $ok present, $missing missing, $unlocated unlocated"
[ "$missing" -eq 0 ]
