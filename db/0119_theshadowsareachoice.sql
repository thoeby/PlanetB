-- 0119_theshadowsareachoice.sql — the frames can be drawn without shadows.
--
-- Whether the stripes across the frames are the shadow map's (frame-v6's
-- self-shadowing, taken out in frame-v7) or the ground's (a dem-v1 tile's 0.2 m
-- steps) is a question a run answers and a thumbnail does not. So, the way
-- db/0107 makes the renderer a choice:
--
--     ALTER DATABASE splatworld SET splatworld.shadows = 'off';
--
-- and every frame atom built after that carries `shadows: false` in its params
-- (Invariant 2: a tile framed flat is a different tile), and the rasteriser
-- draws the sun with no shadow map at all. Stripes that survive that are not
-- the shadows'. Unset, the shadows are drawn.
CREATE OR REPLACE FUNCTION frame_renderer() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT (CASE WHEN coalesce(current_setting('splatworld.renderer', true), '') = 'trace'
    THEN jsonb_build_object('renderer', 'trace',
        'samples', coalesce(nullif(current_setting('splatworld.samples', true), ''), '48')::int,
        'bounces', 3)
    ELSE '{}'::jsonb END)
    || (CASE WHEN coalesce(current_setting('splatworld.shadows', true), '') = 'off'
        THEN jsonb_build_object('shadows', false) ELSE '{}'::jsonb END);
$$;
