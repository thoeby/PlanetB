#!/usr/bin/env bash
# replay.sh — keep a player-run's world so a late story can be run again.
#
# The gate is `make player-run` from an empty database, and that is an hour and
# a half. Writing the last story of that run is not: this saves the database
# and the file store as they are, and puts them back, so the story being
# written runs on its own.
#
#   bash tools/replay.sh save after-25          # after a run got that far
#   bash tools/replay.sh load after-25
#   RUN_KEEP_WORLD=1 make player-run RUN_ARGS=client/test/run/26-*.spec.js
#
# It is a developer's tool on a developer's box (CLAUDE.md, tools/). It proves
# nothing on its own: a story is green when the whole run is.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
store=${REPLAY_DIR:-/tmp/splatworld-replay}
db=${PGDATABASE:-splatworld}
what=${1:-}
name=${2:-last}

case "$what" in
save)
    mkdir -p "$store"
    pg_dump -Fc "$db" > "$store/$name.dump"
    # ALTER DATABASE settings are the cluster's, not the dump's: the JWT secret
    # and the run's small render numbers live there, and a restore without them
    # is a world nobody can sign in to.
    psql -Atq -d "$db" -c "SELECT format('ALTER DATABASE %I SET %s = %L;', '$db',
            split_part(s, '=', 1), substr(s, strpos(s, '=') + 1))
        FROM pg_db_role_setting r, unnest(r.setconfig) AS s
        WHERE r.setdatabase = (SELECT oid FROM pg_database WHERE datname = '$db')" \
        > "$store/$name.settings.sql"
    tar czf "$store/$name-files.tgz" -C "$here" infra/files
    echo "saved $name: $(du -sh "$store/$name.dump" | cut -f1) database," \
         "$(du -sh "$store/$name-files.tgz" | cut -f1) store"
    ;;
load)
    test -f "$store/$name.dump" || { echo "no such replay: $name" >&2; exit 1; }
    pkill -f 'postgrest' 2>/dev/null || true
    dropdb --if-exists "$db"
    createdb "$db"
    pg_restore -d "$db" --no-owner "$store/$name.dump" > /dev/null 2>&1 || true
    test -f "$store/$name.settings.sql" && psql -q -d "$db" -f "$store/$name.settings.sql"
    rm -rf "$here/infra/files"
    tar xzf "$store/$name-files.tgz" -C "$here"
    echo "loaded $name — run with RUN_KEEP_WORLD=1"
    ;;
*)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
