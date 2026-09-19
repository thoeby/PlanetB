#!/usr/bin/env bash
# Writes client/flow/palette/manifest.json from what is in plugins/.
#
# A directory cannot be listed over HTTP and the client has no build step, so
# the page is handed a list. Run this after adding or removing a plugin; the
# gate checks the file is current (client/test/palette.test.js).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)/client/flow/palette"
cd "$root"

{
    echo '{'
    echo '  "plugins": ['
    first=1
    for d in plugins/*/; do
        id="$(basename "$d")"
        [ -f "$d/plugin.xml" ] || continue
        [ $first -eq 1 ] || echo '    },'
        first=0
        echo '    {'
        echo "      \"id\": \"$id\","
        assets="$(cd "$d" && find assets -type f 2>/dev/null | sort || true)"
        if [ -n "$assets" ]; then
            echo "      \"xml\": \"plugins/$id/plugin.xml\","
            echo '      "assets": ['
            echo "$assets" | sed 's/.*/        "&",/' | sed '$ s/,$//'
            echo '      ]'
        else
            echo "      \"xml\": \"plugins/$id/plugin.xml\""
        fi
    done
    echo '    },'
    # The world's own blocks (FND.14). They are not the reference editor's and
    # they are not in plugins/: client/flow/world is a plugin folder whole, so
    # it can be copied into a process server's as it is.
    echo '    {'
    echo '      "id": "world",'
    echo '      "xml": "../world/plugin.xml"'
    echo '    }'
    echo '  ]'
    echo '}'
} > manifest.json

echo "palette: $(grep -c '"id"' manifest.json) plugins"
