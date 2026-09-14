-- Picking a finer detail, or asking for the land again, takes the jobs it has
-- just superseded out of the pool instead of leaving them open for ever.
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land84@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000084'::uuid,
       st_geomfromtext('POLYGON((7.80 46.29,7.81 46.29,7.81 46.30,7.80 46.30,7.80 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000084', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

-- A bounty is money, and money has to come from somewhere.
DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 100, 'seed:money:0084')
    FROM account a WHERE a.owner_id = (SELECT owner_id FROM ids);
END
$$;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;

CREATE TEMP TABLE tt AS SELECT 14 AS z, tile_x(7.805, 14) AS x, tile_y(46.295, 14) AS y;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt), 5) AS jid;

SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'open',
    'a job is open on the land');
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(render_pool(7.805, 46.295, 60)) j
                 WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs)),
    'and the pool offers it');
SELECT is((SELECT bounty FROM job WHERE id = (SELECT jid FROM jobs)), 5::numeric,
    'with its bounty in escrow');

-- Asking for detail 18 moves every covered tile past the version that job
-- compiles, which is what stranded it.
SELECT ok(set_area_detail('00000000-0000-0000-0000-000000000084'::uuid, 18) > 0,
    'picking detail 18 marks the finer tiles');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'cancelled',
    'and the job it superseded is cancelled, not left open');
SELECT is((SELECT bounty FROM job WHERE id = (SELECT jid FROM jobs)), 0::numeric,
    'with its escrow given back');
SELECT ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pool_held_back(60)) h
                     WHERE (h ->> 'job')::bigint = (SELECT jid FROM jobs)),
    'so nothing is held back waiting on a version that has gone');

-- And the other door into the same room.
CREATE TEMP TABLE j2 AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt), 0) AS jid;
SELECT ok(recompile_land('00000000-0000-0000-0000-000000000084'::uuid) > 0,
    'compiling it all again marks the ground');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM j2)), 'cancelled',
    'and clears the job that was building the version before it');

ROLLBACK;
