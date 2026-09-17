-- What the pool says can be taken, against what claim_for will actually hand
-- out. They disagreed: a job whose first piece gave up for good counted the two
-- pieces waiting behind it as work to do, so the row offered Render and the
-- button claimed nothing.
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('own87@example.com', 'password12') AS owner_id,
       register('rnd87@example.com', 'password12') AS worker_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000087'::uuid,
       st_geomfromtext('POLYGON((7.80 46.29,7.81 46.29,7.81 46.30,7.80 46.30,7.80 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000087', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.805, 14), tile_y(46.295, 14)) AS jid;

CREATE TEMP TABLE fresh AS
SELECT j FROM jsonb_array_elements(render_pool(7.805, 46.295, 20)) j
WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs);
SELECT is((SELECT (j ->> 'ready')::int FROM fresh), 1,
    'one piece can be taken: the assemble everything else waits on');
-- Everything else in the job — the frames, the training, the encoding — is
-- waiting on that one piece, and the row says so rather than counting them as
-- work a tab could take.
SELECT is((SELECT (j ->> 'blocked')::int FROM fresh),
    (SELECT count(*)::int - 1 FROM atom WHERE job_id = (SELECT jid FROM jobs)),
    'and the rest are waiting on it rather than "to do"');

-- It gives up for good.
UPDATE atom SET state = 'failed', attempts = 3
WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble';

CREATE TEMP TABLE dead AS
SELECT j FROM jsonb_array_elements(render_pool(7.805, 46.295, 20)) j
WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs);
SELECT is((SELECT (j ->> 'ready')::int FROM dead), 0,
    'now nothing at all can be taken');
SELECT is((SELECT (j ->> 'blocked')::int FROM dead),
    (SELECT count(*)::int - 1 FROM atom WHERE job_id = (SELECT jid FROM jobs)),
    'and the ones behind it say so');
SELECT is((SELECT (j ->> 'failed')::int FROM dead), 1, 'one gave up');

-- Which is what the claim agrees with, and used not to.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
SELECT is((claim_for((SELECT jid FROM jobs),
           '{"webgpu": true, "max_buffer_mb": 4096}'::jsonb)).id, null,
    'no tab can be handed anything of it');

-- A GPU job says what it needs of what is left, not of the whole job: a tile
-- whose training is done and whose encoding is not asks for no GPU.
SELECT is((SELECT (j ->> 'needs_webgpu')::boolean FROM dead), false,
    'and nothing left of this one needs a GPU');

-- What this land is compiled into, apart from the ladder above it. The z6
-- tile over a Valais hillside is six hundred kilometres across and belongs to
-- everybody; "Rendered 0 / 22" for half a hectare counted it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE prog AS
SELECT area_progress('00000000-0000-0000-0000-000000000087') AS p;
SELECT cmp_ok(((SELECT p FROM prog) ->> 'leaves')::int, '<',
    ((SELECT p FROM prog) ->> 'tiles')::int,
    'a land is compiled into fewer tiles than overlap it');
SELECT is((SELECT count(*)::int FROM tile t
           WHERE is_leaf_tile(t.z, t.x, t.y)
             AND st_intersects((SELECT geom FROM area
                                WHERE id = '00000000-0000-0000-0000-000000000087'),
                               tile_bbox(t.z, t.x, t.y))),
    ((SELECT p FROM prog) ->> 'leaves')::int,
    'and those are exactly the leaves, which is what a submission sends');

ROLLBACK;
