-- What happened to a tile is written down. The reason a tab gave lived on
-- atom.result until the next attempt overwrote it, and the rule that refused a
-- finished run lived in verification.metrics, which nothing read.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('log143@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT compile_ground();

CREATE TEMP TABLE t AS
SELECT j.id AS job, j.z, j.x, j.y FROM job j WHERE j.state = 'open' AND j.z = 14
ORDER BY j.id LIMIT 1;

SELECT is((SELECT count(*) FROM tile_event e, t WHERE e.z = t.z AND e.x = t.x AND e.y = t.y),
    0::bigint, 'a tile nobody has touched has nothing against it');

-- Take a piece and give it back with a reason, twice.
CREATE TEMP TABLE first AS SELECT (claim_for((SELECT job FROM t), '{}'::jsonb)).id AS id;
SELECT is(fail_atom((SELECT id FROM first), 'the elevation service did not answer'),
    'ready', 'the piece goes back for somebody else');

SELECT is((SELECT count(*) FROM tile_event e, t
           WHERE e.z = t.z AND e.x = t.x AND e.y = t.y AND e.kind = 'failed'),
    1::bigint, 'and the tile remembers it');
SELECT is((SELECT e.detail FROM tile_event e, t
           WHERE e.z = t.z AND e.x = t.x AND e.y = t.y ORDER BY e.id DESC LIMIT 1),
    'the elevation service did not answer', 'in the words the tab used');

PERFORM claim_for((SELECT job FROM t), '{}'::jsonb);
SELECT fail_atom((SELECT id FROM first), 'and again');
PERFORM claim_for((SELECT job FROM t), '{}'::jsonb);
SELECT is(fail_atom((SELECT id FROM first), 'and again'), 'failed',
    'the third attempt is the last');
SELECT is((SELECT count(*) FROM tile_event e, t
           WHERE e.z = t.z AND e.x = t.x AND e.y = t.y AND e.kind = 'gave_up'),
    1::bigint, 'and that one is marked as the one somebody must look at');
SELECT is((SELECT count(*) FROM tile_event e, t
           WHERE e.z = t.z AND e.x = t.x AND e.y = t.y),
    3::bigint, 'three attempts, three lines, none of them lost');

SELECT * FROM finish();
ROLLBACK;
