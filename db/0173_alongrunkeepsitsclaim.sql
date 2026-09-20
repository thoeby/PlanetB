-- 0173_alongrunkeepsitsclaim.sql — a training run is not taken away from the
-- tab that is doing it, and the world says how big it is being built.
--
-- Two halves of one report. An operator pressed Render on a tile and the tile
-- came back "the claim went quiet and the world took the piece back", and the
-- tiles that did finish looked poor.
--
-- Both are `make player-run` leaving its own numbers on the operator's
-- database. The run turns the world down so the stories can render at all
-- (db/0131, db/0132) with ALTER DATABASE, which persists: after one run the
-- operator's world is built at a twentieth of the budget, sixty iterations and
-- 192 px frames, and every claim is leased for 150 seconds. The run now puts
-- them back (client/test/run/world.js), but a world that has been through an
-- older one is already turned down and nothing on the page said so. So:
--
--   * `world_size` reads the four numbers out, each beside the default it
--     replaced, so the page can say it (client/js/worksettings.js).
--   * `claim_patience` stops letting one turned-down lease take a training run
--     away. Training is the op that goes quiet for half an hour at a time; the
--     ordinary lease is what story 13 turns down, and it is not that number.
--
-- `splatworld.lease` is the ordinary lease, as it was. Training's is
-- `splatworld.lease_train`, and unset it is six times the ordinary one —
-- the multiple it has always had (thirty minutes against five). Turning the
-- lease down to 150 seconds now leaves training fifteen minutes, not two and a
-- half, and an operator who wants training turned down too says so.
CREATE OR REPLACE FUNCTION claim_patience(p_op text) RETURNS interval
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN p_op = 'train' THEN coalesce(
        nullif(current_setting('splatworld.lease_train', true), '')::interval,
        nullif(current_setting('splatworld.lease', true), '')::interval * 6,
        interval '30 minutes')
    ELSE coalesce(
        nullif(current_setting('splatworld.lease', true), '')::interval,
        interval '5 minutes') END;
$$;

REVOKE ALL ON FUNCTION claim_patience(text) FROM PUBLIC;

-- What the world is built at when nobody has said otherwise, in one place.
-- The defaults were written into each reader (db/0131, db/0148), so a page
-- that wanted to say "60 iterations, not 2400" had to carry a second copy of
-- the number and go stale the next time one moved. One function, and every
-- reader below coalesces onto it.
CREATE OR REPLACE FUNCTION world_default(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_key
    WHEN 'budget_scale' THEN '1'
    WHEN 'iters' THEN '2400'
    WHEN 'frame_px' THEN '1024'
    WHEN 'lease' THEN '00:05:00'
    WHEN 'lease_train' THEN '00:30:00' END;
$$;

CREATE OR REPLACE FUNCTION budget_scale() RETURNS numeric
LANGUAGE sql STABLE AS $$
SELECT least(greatest(coalesce(
    nullif(current_setting('splatworld.budget_scale', true), ''),
    world_default('budget_scale'))::numeric, 0.001), 1);
$$;

CREATE OR REPLACE FUNCTION train_iters() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(coalesce(
    nullif(current_setting('splatworld.iters', true), ''),
    world_default('iters'))::int, 1);
$$;

CREATE OR REPLACE FUNCTION frame_px() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(coalesce(
    nullif(current_setting('splatworld.frame_px', true), ''),
    world_default('frame_px'))::int, 64);
$$;

-- What the world is being built at, and what it would be built at if nobody
-- had said otherwise. Public, because how big the tiles you are looking at
-- were built is not a secret — and because the one thing that made this bug
-- unfindable is that the numbers were invisible.
CREATE OR REPLACE FUNCTION world_size() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT jsonb_object_agg(key, jsonb_build_object(
    'is', is_now, 'default', world_default(key), 'set', asked))
FROM (
    SELECT 'budget_scale' AS key, budget_scale()::text AS is_now,
        nullif(current_setting('splatworld.budget_scale', true), '') IS NOT NULL AS asked
    UNION ALL SELECT 'iters', train_iters()::text,
        nullif(current_setting('splatworld.iters', true), '') IS NOT NULL
    UNION ALL SELECT 'frame_px', frame_px()::text,
        nullif(current_setting('splatworld.frame_px', true), '') IS NOT NULL
    UNION ALL SELECT 'lease', claim_patience('assemble')::text,
        nullif(current_setting('splatworld.lease', true), '') IS NOT NULL
    UNION ALL SELECT 'lease_train', claim_patience('train')::text,
        nullif(current_setting('splatworld.lease_train', true), '') IS NOT NULL
            OR nullif(current_setting('splatworld.lease', true), '') IS NOT NULL
) AS one;
$$;

GRANT EXECUTE ON FUNCTION world_default(text), world_size() TO anon, player, admin;

CREATE FUNCTION api.world_size() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.world_size()$$;

GRANT EXECUTE ON FUNCTION api.world_size() TO anon, player, admin;
