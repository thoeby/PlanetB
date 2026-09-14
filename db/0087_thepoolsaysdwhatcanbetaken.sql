-- 0087_thepoolsaysdwhatcanbetaken.sql — the pool counts work that can be taken
-- apart from work that cannot.
--
-- `render_pool` reported one number, `ready`, and it counted atoms in 'ready'
-- and atoms in 'waiting' together. Those are not the same thing at all: a
-- ready atom is work this tab can be given, and a waiting one is work blocked
-- behind a dependency that has not finished — often one that gave up for good.
--
-- So a job whose assemble failed three times read as "2 piece(s) to do", the
-- row offered a Render button, pressing it claimed nothing, and the tile stayed
-- in the list saying the same thing. At any scale it is worse: eighteen open
-- jobs of which one has a claimable atom look like eighteen tiles somebody
-- could be compiling.
--
-- Two numbers now. `ready` is what claim_for could hand out; `blocked` is what
-- is waiting on something else in the same job. client/js/poolui.js says which
-- is which, and offers Render only where there is something to claim.
--
-- Nothing about what may be claimed changes — this is what the pool says about
-- itself.
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        -- What a tab could be handed right now.
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state = 'ready'),
        -- And what is waiting on something else in this job to finish first.
        'blocked', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'waiting'),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                        WHERE a.job_id = job.id),
        'may_retry', may_retry_job(job.id),
        'made', CASE
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
            ELSE 'merged from its children' END,
        -- Of what could be taken, not of the job: a tile whose training is
        -- done and whose encoding is not needs no GPU from the next tab.
        'needs_webgpu', EXISTS (
            SELECT 1 FROM atom a WHERE a.job_id = job.id AND a.state = 'ready'
              AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
        'needs_mb', (SELECT coalesce(max(atom_buffer_mb(a)), 0) FROM atom a
                     WHERE a.job_id = job.id AND a.state = 'ready'),
        'metres', CASE WHEN p_lon IS null THEN null ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS null THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
    WHERE job.state = 'open'
      AND job.target_version = t.expected_version
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
      AND NOT EXISTS (SELECT 1 FROM atom a
                      WHERE a.job_id = job.id AND a.op = 'merge'
                        AND a.state IN ('ready', 'waiting')
                        AND NOT merge_has_a_child(a.inputs))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;

-- ------------------------------------------------ and what a land is made of

-- db/0070_therebuildopensitself.sql's area_progress, with two numbers added
-- and none changed.
--
-- The chrome reads "Rendered {published} / {tiles}", and `tiles` is every tile
-- whose box overlaps this land — from z6 up. The z6 tile over a Valais
-- hillside is six hundred kilometres across and belongs to everybody; counting
-- it among a half-hectare's twenty-two reads as "you own twenty-two tiles",
-- which nobody does.
--
-- `leaves` is what this land is actually compiled into: the tiles a submission
-- sends (db/0070 submit_area picks exactly these), which is z14 and finer, or
-- a coarse tile with nothing under it. The ladder above them is the world's,
-- rebuilt from every land beneath it, and is still counted in `tiles` for
-- anything that wants it.
CREATE OR REPLACE FUNCTION area_progress(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', count(*),
    'published', count(*) FILTER (WHERE t.published_version >= t.expected_version),
    'leaves', count(*) FILTER (WHERE is_leaf_tile(t.z, t.x, t.y)),
    'leaves_published', count(*) FILTER (
        WHERE is_leaf_tile(t.z, t.x, t.y)
          AND t.published_version >= t.expected_version),
    'waiting', count(*) FILTER (WHERE t.dirty),
    'awaiting', count(*) FILTER (WHERE tile_state(t) = 'awaiting approval'),
    'to_submit', count(*) FILTER (
        WHERE t.dirty AND t.expected_version > 0
          AND is_leaf_tile(t.z, t.x, t.y) AND NOT EXISTS (
            SELECT 1 FROM submission s
            INNER JOIN submission_tile st ON st.submission_id = s.id
            WHERE s.state = 'open' AND st.z = t.z AND st.x = t.x AND st.y = t.y)),
    'queued', count(*) FILTER (WHERE tile_state(t) IN ('queued', 'rendering')),
    'open_jobs', (SELECT count(*) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))),
    'in_escrow', coalesce((SELECT sum(j.bounty) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))), 0))
FROM tile t
WHERE EXISTS (SELECT 1 FROM area a WHERE a.id = p_area
              AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y)));
$$;
