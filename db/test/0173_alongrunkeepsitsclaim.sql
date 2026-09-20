-- A training run keeps its claim when the ordinary lease is turned down, and
-- the world says how big it is being built (db/0173).
BEGIN;
SELECT plan(10);

SET client_min_messages = warning;
SET search_path = api, public;

-- Unset, the two leases are what they always were.
SELECT is(public.claim_patience('assemble'), interval '5 minutes',
    'an ordinary claim is left alone for five minutes');
SELECT is(public.claim_patience('train'), interval '30 minutes',
    'a training claim for half an hour');

-- The operator turns the ordinary lease down, the way `make player-run` does.
SET splatworld.lease = '150 seconds';

SELECT is(public.claim_patience('assemble'), interval '150 seconds',
    'the ordinary lease is the operator''s number');
SELECT is(public.claim_patience('train'), interval '900 seconds',
    'and training keeps the six-fold patience it has always had');

-- And says so about training too, when that is what they mean.
SET splatworld.lease_train = '4 minutes';
SELECT is(public.claim_patience('train'), interval '4 minutes',
    'training''s own number wins where there is one');

RESET splatworld.lease_train;
RESET splatworld.lease;

-- What the world is built at, beside what it would be built at.
SELECT is(public.world_size() -> 'iters' ->> 'is', public.world_default('iters'),
    'an untouched world trains for as many iterations as the default says');
SELECT is(public.world_size() -> 'iters' ->> 'set', 'false',
    'and says nobody asked for that');

SET splatworld.iters = '60';
SET splatworld.budget_scale = '0.05';

SELECT is(public.world_size() -> 'iters' ->> 'is', '60',
    'a turned-down world says the number it is really using');
SELECT is(public.world_size() -> 'iters' ->> 'set', 'true',
    'and that somebody asked for it');
SELECT is(public.world_size() -> 'budget_scale' ->> 'is', '0.05',
    'the budget scale is read the same way');

RESET splatworld.iters;
RESET splatworld.budget_scale;

SELECT * FROM finish();
ROLLBACK;
