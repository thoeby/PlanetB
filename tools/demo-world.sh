#!/usr/bin/env bash
# Seeds a world you can actually look at: an operator, a ground, a piece of
# land with things drawn on it, a second player with a grant, and some credits.
#
# It is what the panels need in order to show anything, and doing it by hand
# takes ten minutes and gets the owner wrong (db/0058). Safe to re-run.
#
#     set -a; . ./.env; set +a; bash tools/demo-world.sh
set -euo pipefail

PSQL=${PSQL:-psql}
EMAIL=${DEMO_EMAIL:-op@splatworld.local}
PW=${DEMO_PASSWORD:-password123}
MATE=${DEMO_MATE:-ben@splatworld.local}
# A patch of the pilot region, so the DEM the seeds cut actually covers it.
WEST=${DEMO_WEST:-8.00}
SOUTH=${DEMO_SOUTH:-47.00}
EAST=${DEMO_EAST:-8.06}
NORTH=${DEMO_NORTH:-47.04}

# WKT carries no arithmetic: a shell expansion inside a quoted literal would be
# text, not a coordinate, so the offsets are worked out here and only finished
# numbers go into the geometry.
off() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.6f", a + b }'; }
W1=$(off "$WEST" 0.01);   W2=$(off "$WEST" 0.02)
W3=$(off "$WEST" 0.03);   W4=$(off "$WEST" 0.04)
W5=$(off "$WEST" 0.05)
S05=$(off "$SOUTH" 0.005); S1=$(off "$SOUTH" 0.01)
S2=$(off "$SOUTH" 0.02);   S3=$(off "$SOUTH" 0.03)
S35=$(off "$SOUTH" 0.035)
GW=$(off "$WEST" -0.1);   GS=$(off "$SOUTH" -0.1)
GE=$(off "$EAST" 0.1);    GN=$(off "$NORTH" 0.1)

$PSQL -v ON_ERROR_STOP=1 --no-psqlrc -q <<SQL
DO \$\$
DECLARE uid uuid; mate uuid; aid uuid; acc uuid;
BEGIN
    SELECT id INTO uid FROM auth.user WHERE email = '$EMAIL';
    IF uid IS NULL THEN
        uid := register('$EMAIL', '$PW');
    END IF;
    UPDATE auth.user SET role = 'admin' WHERE id = uid;

    SELECT id INTO mate FROM auth.user WHERE email = '$MATE';
    IF mate IS NULL THEN
        mate := register('$MATE', '$PW');
    END IF;

    -- The ground is what makes this operator the owner of what is drawn
    -- (db/0058_drawnbyoperator.sql), so it goes in before the land does.
    DELETE FROM ground;
    INSERT INTO ground (geoserver_url, coverage, extent, set_by)
    VALUES ('http://localhost:8080/geoserver', 'splatworld:demo_dem',
            st_makeenvelope($GW, $GS, $GE, $GN, world_srid()), uid);

    SELECT id INTO aid FROM area
    WHERE rules ->> 'name' = 'Maloja Nord' AND owner_id = uid;
    IF aid IS NULL THEN
        INSERT INTO area (geom, owner_id, detail, rules)
        VALUES (st_makeenvelope($WEST, $SOUTH, $EAST, $NORTH, world_srid()), uid, 14,
                '{"name": "Maloja Nord", "required_approvals": 1}'::jsonb)
        RETURNING id INTO aid;
    END IF;

    -- Somebody to grant to, so the People card has a person in it.
    INSERT INTO grant_ (area_id, grantee_id, right_) VALUES (aid, mate, 'edit')
    ON CONFLICT DO NOTHING;

    -- Something drawn, as QGIS draws it: multi-part, through the same views.
    DELETE FROM feature WHERE area_id = aid;
    INSERT INTO feature (area_id, kind, geom) VALUES
        (aid, 'water', st_force3d(st_geomfromtext(
            'MULTIPOLYGON((($W2 $S2, $W3 $S2, $W3 $S3, $W2 $S2)))', world_srid()))),
        (aid, 'forest', st_force3d(st_geomfromtext(
            'MULTIPOLYGON((($W4 $S1, $W5 $S1, $W5 $S2, $W4 $S1)))', world_srid()))),
        (aid, 'road', st_force3d(st_geomfromtext(
            'MULTILINESTRING(($W1 $S05, $W5 $S35))', world_srid())));

    -- Credits, so the wallet and the pool have something to say.
    SELECT id INTO acc FROM account WHERE owner_id = uid;
    IF acc IS NULL THEN
        INSERT INTO account (owner_id) VALUES (uid) RETURNING id INTO acc;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger WHERE ref = 'topup:demo:' || uid) THEN
        PERFORM transfer(treasury_account(), acc, 250, 'topup:demo:' || uid);
    END IF;

    RAISE NOTICE 'demo world: % owns Maloja Nord with % thing(s) on it',
        '$EMAIL', (SELECT count(*) FROM feature WHERE area_id = aid);
END
\$\$;
SQL

echo "demo-world: sign in as $EMAIL / $PW"
