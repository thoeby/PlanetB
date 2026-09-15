-- The frames carry the renderer the operator chose (db/0107).
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;

SELECT is(frame_renderer(), '{}'::jsonb, 'unset, the rasteriser draws the frames');
SELECT set_config('splatworld.renderer', 'trace', true);
SELECT set_config('splatworld.samples', '64', true);
SELECT is(frame_renderer() ->> 'renderer', 'trace', 'set, the tracer does');
SELECT is((frame_renderer() ->> 'samples')::int, 64, 'with the samples asked for');

SELECT * FROM finish();
ROLLBACK;
