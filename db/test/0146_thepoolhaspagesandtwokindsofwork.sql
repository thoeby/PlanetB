-- The pool reads a page at a time, says which of two kinds of work a tile is
-- waiting for, and carries what went wrong on the tile so a card can show it.
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('page146@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT compile_ground();

CREATE TEMP TABLE all_ AS SELECT pool_page(7.89, 46.30, NULL, 4, 0) AS p;
SELECT ok(((SELECT p FROM all_) ->> 'total')::int > 4, 'there is more than one page');
SELECT is(jsonb_array_length((SELECT p FROM all_) -> 'rows'), 4, 'and a page holds four');

-- The second page is four more, and none of them is on the first.
CREATE TEMP TABLE two AS SELECT pool_page(7.89, 46.30, NULL, 4, 4) AS p;
SELECT is(jsonb_array_length((SELECT p FROM two) -> 'rows'), 4, 'the next page too');
SELECT is((SELECT count(*) FROM
    jsonb_array_elements((SELECT p FROM all_) -> 'rows') a,
    jsonb_array_elements((SELECT p FROM two) -> 'rows') b
    WHERE a ->> 'job' = b ->> 'job'), 0::bigint, 'and they are different tiles');
SELECT is(((SELECT p FROM two) ->> 'offset')::int, 4, 'which the page says of itself');

-- Nothing is trained until its frames are, so the whole pool is render work.
SELECT is(((SELECT p FROM all_) ->> 'train')::int, 0,
    'nothing is waiting to be trained yet');
SELECT ok(((SELECT p FROM all_) ->> 'render')::int > 0, 'and everything is waiting to be drawn');
SELECT is((SELECT count(*) FROM jsonb_array_elements((SELECT p FROM all_) -> 'rows') r
           WHERE r ->> 'phase' <> 'render'), 0::bigint, 'every card says so');

-- What went wrong on a tile travels with its card (db/0143).
CREATE TEMP TABLE one AS
SELECT (jsonb_array_elements((SELECT p FROM all_) -> 'rows') ->> 'job')::bigint AS job
ORDER BY 1 ASC LIMIT 1;
SELECT fail_atom((claim_for((SELECT job FROM one), '{}'::jsonb)).id, 'the store lost an asset');
SELECT is((SELECT pool_row((SELECT job FROM one)) -> 'log' -> 0 ->> 'detail'),
    'the store lost an asset', 'the card carries the reason, not just a count');

SELECT * FROM finish();
ROLLBACK;
