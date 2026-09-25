-- A part may move, and every tab evaluates the same motion (db/0200).
BEGIN;
SELECT plan(17);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('crane199@example.com', 'password12') AS ben;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');

-- A crane whose arm is a joint, told three ways.
SELECT lives_ok($$SELECT check_marks('{"parts": [{"name": "arm", "node": "arm",
    "role": "joint"}], "ports": [
    {"name": "pose", "type": "pose", "default": "", "drives": {"part": "arm", "what": "pose"}},
    {"name": "path", "type": "path", "default": "", "drives": {"part": "arm", "what": "path"}},
    {"name": "spin", "type": "spin", "default": "", "drives": {"part": "arm", "what": "spin"}}
    ]}'::jsonb)$$, 'a joint may be told a pose, a path and a spin');

INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SCRANECRANECR', repeat('a', 64), 2, 'Kran', 'prop', '{}'::jsonb, 10, 0,
    'cc0', who.ben, 'model',
    '{"parts": [{"name": "arm", "node": "arm", "role": "joint"}], "ports": [
      {"name": "pose", "type": "pose", "default": "", "drives": {"part": "arm", "what": "pose"}},
      {"name": "spin", "type": "spin", "default": "", "drives": {"part": "arm", "what": "spin"}},
      {"name": "path", "type": "path", "default": "", "drives": {"part": "arm", "what": "path"}}
    ]}'::jsonb
FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000199a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000199b1'::uuid,
        '00000000-0000-0000-0000-0000000199a1'::uuid, 'SCRANECRANECR', 7.862, 46.286);
CREATE TEMP TABLE thing AS SELECT '00000000-0000-0000-0000-0000000199b1'::uuid AS id;
GRANT SELECT ON thing TO player, admin;

-- The motion itself, the numbers client/lib/joint.js is tested against.
SELECT is(pose_at('{"to": {"yaw": 90}, "over_s": 4}', rest_pose(), 100, 102) ->> 'yaw',
          '45', 'half way through a four-second swing, half way round');
SELECT is(pose_at('{"to": {"yaw": 90}, "over_s": 4}', rest_pose(), 100, 200) ->> 'yaw',
          '90', 'and there once the time is up');
SELECT is(pose_at('{"to": {"yaw": 90}, "over_s": 4}', rest_pose(), 100, 99) ->> 'yaw',
          '0', 'and not yet moved before it was told');
SELECT is(spin_at('{"axis": "y", "rpm": 10}', rest_pose(), 100, 101.5) ->> 'yaw',
          '90', 'ten turns a minute is a quarter turn in a second and a half');
SELECT is(path_at('{"route_m": [[0,0,0],[10,0,0],[10,0,10]], "speed": 2, "loop": false}',
                  100, 107.5) ->> 'z', '5', 'a path is walked metre by metre');
SELECT is(path_at('{"route_m": [[0,0,0],[10,0,0]], "speed": 2, "loop": true}',
                  100, 106) ->> 'x', '2', 'and round again when it loops');

CREATE TEMP TABLE v0 AS SELECT coalesce(sum(expected_version), 0) AS v FROM tile;
GRANT SELECT ON v0 TO player, admin;

-- A write records the clock, and where the part was.
CREATE TEMP TABLE w1 AS
SELECT port_write((SELECT id FROM thing), 'pose', '{"to": {"yaw": 90}, "over_s": 4}') AS r;
SELECT ok((SELECT (r ->> 'clock')::float8 FROM w1) BETWEEN world_clock() - 5 AND world_clock() + 5,
          'a write records the world clock');
SELECT is((SELECT r -> 'start' ->> 'yaw' FROM w1), '0',
          'and starts from where the maker left the part');

-- A second write starts from where the first one had got to.
UPDATE live_state SET clock = clock - 2 WHERE port = 'pose';
CREATE TEMP TABLE w2 AS
SELECT port_write((SELECT id FROM thing), 'pose', '{"to": {"yaw": 0}, "over_s": 4}') AS r;
SELECT ok(abs((SELECT (r -> 'start' ->> 'yaw')::float8 FROM w2) - 45) < 1,
          'a new move starts where the last one had got to');

-- A flow says it in words; the world reads the object in them.
SELECT is(port_write((SELECT id FROM thing), 'spin', '"{\"axis\": \"y\", \"rpm\": 6}"')
              -> 'value' ->> 'rpm', '6', 'a motion said as words is read as one');

SELECT throws_like($$SELECT port_write((SELECT id FROM thing), 'pose',
    '{"to": {"height": 3}}')$$, '%x, y, z, yaw, pitch, roll and scale%',
    'a pose moves only what a part has');
SELECT throws_like($$SELECT port_write((SELECT id FROM thing), 'path',
    '{"route_m": [[0,0,0]], "speed": 1}')$$, '%at least two points%',
    'a path is at least two points');
SELECT throws_like($$SELECT port_write((SELECT id FROM thing), 'spin',
    '{"axis": "w", "rpm": 1}')$$, '%x, y or z%', 'and a spin is about an axis');

SELECT ok((SELECT bool_and(x ? 'clock' AND x ? 'start')
           FROM jsonb_array_elements(live_near(7.862, 46.286, 500, 0)) x),
          'every tab near it is told the clock and the start');

-- Invariant 2: nothing a port says is baked, so nothing is dirtied.
SELECT is((SELECT coalesce(sum(expected_version), 0) FROM tile), (SELECT v FROM v0),
          'telling a part to move dirties no tile');
SELECT is(algo_current('dataset'), 'dataset-v9', 'and the bake leaves every role part out');

SELECT * FROM finish();
ROLLBACK;
