-- The shapes that used to move the ground, and the kind retiring behind them
-- (db/0164, db/0165).
BEGIN;
SELECT plan(14);

SET client_min_messages = warning;
-- As PostgREST calls them: `api` ahead of `public`, where `area` and `feature`
-- are views rather than the tables. A function that is not qualified for that
-- resolves to the wrong row type and is not found at all.
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('shapes142@example.com', 'password12') AS ben,
       register('other142@example.com', 'password12') AS ott,
       register('boss142@example.com', 'password12') AS ann;
-- PLAN-identity.md: these players are verified people (db/0195).
INSERT INTO player_verification (player_id, state, method, how)
SELECT id, 'verified', 'manual', 'fixture' FROM auth.user ON CONFLICT DO NOTHING;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000142a1'::uuid,
    st_setsrid(st_makeenvelope(7.8, 46.29, 7.804, 46.292), 4326), who.ben, 14
FROM who;
CREATE TEMP TABLE land AS
SELECT '00000000-0000-0000-0000-0000000142a1'::uuid AS id;

SELECT is(old_shapes() ->> 'shapes', '0', 'a world with no old shapes says so');

INSERT INTO feature (area_id, kind, geom, props)
SELECT (SELECT id FROM land), 'terrainmod',
    st_force3d(st_setsrid(st_makeenvelope(7.801, 46.290, 7.802, 46.291), 4326)),
    '{"op": "flatten", "amount": "0"}'::jsonb;

SELECT is(old_shapes() ->> 'shapes', '1', 'and one with one says that');
SELECT is(jsonb_array_length(old_shapes() -> 'lands'), 1, 'on one land');
SELECT is(old_shapes() -> 'lands' -> 0 ->> 'id', (SELECT id::text FROM land),
          'named the way every other panel names a land');
SELECT isnt(old_shapes() -> 'lands' -> 0 -> 'outline', NULL,
            'with the outline the tab needs to shape it');

SELECT is(jsonb_array_length(area_shapes((SELECT id FROM land))), 1,
          'the land hands over its shapes');
SELECT is(area_shapes((SELECT id FROM land)) -> 0 -> 'props' ->> 'op', 'flatten',
          'with what each of them said to do');

-- Invariant 6: a land is shaped by whoever may build on it, and retiring its
-- shapes is shaping it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ott, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT retire_shapes((SELECT id FROM land))$$,
    '%only shape your own land%', 'somebody else cannot retire them');

-- The operator may, because the conversion is theirs and it is every land.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ann, 'role', 'admin')::text, true) FROM who;

SELECT throws_like($$SELECT retire_shape_kind()$$,
    '%still 1 terrain edit%', 'the kind cannot be retired over a live shape');

SELECT is(retire_shapes((SELECT id FROM land)), 1, 'the operator retires them');
SELECT ok(gis_layers() @> '[{"kind": "terrainmod"}]'::jsonb,
          'QGIS is still offered the layer while the kind is drawable');
SELECT is(retire_shape_kind() ->> 'retired', 'true', 'and then the kind itself');
SELECT ok(NOT (gis_layers() @> '[{"kind": "terrainmod"}]'::jsonb),
          'after which no project has it in it');
SELECT ok(NOT EXISTS (SELECT 1 FROM symbol WHERE kind = 'terrainmod' AND enabled),
          'and no symbol draws one');

SELECT finish();
ROLLBACK;
