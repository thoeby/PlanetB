-- The pool cuts on the key it is presented by. The limit used to fall on
-- (bounty, job id): with nothing bountied that is "the world's first N jobs",
-- and a job opened where the player stands is the newest there is, so it was
-- cut before distance was ever looked at.
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('near142@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.70, 46.20, 8.10, 46.40);
SELECT ok(compile_ground() > 20, 'a ground wide enough to have a far side');

-- Standing at its east end. Pay still comes before proximity (the panel has a
-- Best pay and a Nearest), so the truth is the same order the rows are shown
-- in — which is the whole point: the cut and the sort must agree.
CREATE TEMP TABLE pool AS
SELECT ordinality AS place, (e ->> 'x')::int AS x, (e ->> 'y')::int AS y
FROM jsonb_array_elements(render_pool(8.09, 46.39, 5)) WITH ORDINALITY AS t (e, ordinality);

CREATE TEMP TABLE want AS
SELECT row_number() OVER () AS place, j.x, j.y
FROM (
    SELECT j.x, j.y FROM job j INNER JOIN tile t
        ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE j.state = 'open' AND j.target_version = t.expected_version
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
      AND NOT EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id AND a.op = 'merge'
                      AND a.state IN ('ready', 'waiting') AND NOT merge_has_a_child(a.inputs))
    ORDER BY j.bounty DESC,
        st_distance(st_centroid(tile_bbox(j.z, j.x, j.y))::geography,
                    st_setsrid(st_makepoint(8.09, 46.39), world_srid())::geography) ASC,
        j.id ASC
    LIMIT 5) AS j;

SELECT is((SELECT count(*) FROM pool), 5::bigint, 'five came back');
SELECT is((SELECT count(*) FROM pool p INNER JOIN want w
           ON w.place = p.place AND w.x = p.x AND w.y = p.y), 5::bigint,
    'and they are the five the sort would have shown, in that order');

-- The regression itself, with pay held equal: among free jobs the nearest is
-- offered first, however much later it was opened. It used to be whichever
-- free job the world happened to open earliest, and a job under the player's
-- feet is the newest there is.
CREATE TEMP TABLE first_free AS
SELECT (e ->> 'x')::int AS x, (e ->> 'y')::int AS y
FROM jsonb_array_elements(render_pool(8.09, 46.39, 100000)) WITH ORDINALITY AS t (e, ordinality)
WHERE (e ->> 'bounty')::numeric = 0
ORDER BY ordinality LIMIT 1;

CREATE TEMP TABLE nearest_free AS
SELECT j.x, j.y FROM job j INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
WHERE j.state = 'open' AND j.bounty = 0 AND j.target_version = t.expected_version
  AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id
              AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
  AND NOT EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id AND a.op = 'merge'
                  AND a.state IN ('ready', 'waiting') AND NOT merge_has_a_child(a.inputs))
ORDER BY st_distance(st_centroid(tile_bbox(j.z, j.x, j.y))::geography,
                     st_setsrid(st_makepoint(8.09, 46.39), world_srid())::geography), j.id
LIMIT 1;

SELECT is((SELECT count(*) FROM first_free f INNER JOIN nearest_free n
           ON n.x = f.x AND n.y = f.y), 1::bigint,
    'the first tile offered for nothing is the nearest tile offered for nothing');

SELECT * FROM finish();
ROLLBACK;
