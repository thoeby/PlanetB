-- A tile is drawn with its siblings or not at all: client/js/traverse.js
-- refines into children only when every child the world has a row for is
-- published, so the pool has to say how many of them there are.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('sib88@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000088'::uuid,
       st_geomfromtext('POLYGON((7.875 46.290,7.885 46.290,7.885 46.300,7.875 46.300,7.875 46.290))',
                       4326),
       ids.owner_id, 16
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000088', 'footprint',
        st_geomfromtext('POINTZ(7.880 46.295 650)', 4326));

CREATE TEMP TABLE tt AS
SELECT 16 AS z, tile_x(7.880, 16) AS x, tile_y(46.295, 16) AS y;

SELECT cmp_ok(((SELECT sibling_tiles(z, x, y) FROM tt) ->> 'siblings')::int, '>', 1,
    'a z16 tile of this land has siblings under the same parent');
SELECT is(((SELECT sibling_tiles(z, x, y) FROM tt) ->> 'siblings_published')::int, 0,
    'none of them is published yet');

-- Only the rows the world has: a child outside any compiled area has none, and
-- is not a hole the viewer has to wait for.
SELECT cmp_ok(((SELECT sibling_tiles(z, x, y) FROM tt) ->> 'siblings')::int, '<=', 16,
    'and never more than the sixteen a parent can hold');

-- The pool carries them, which is what the row says the tile is waiting for.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
CREATE TEMP TABLE r AS
SELECT j FROM jsonb_array_elements(render_pool(7.880, 46.295, 40)) j
WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs);
SELECT ok((SELECT j ? 'siblings' FROM r), 'the pool row says how many there are');
SELECT is((SELECT (j ->> 'siblings_published')::int FROM r), 0,
    'and how many of them are drawn');

ROLLBACK;
