-- The world's vocabulary is rows, not code (db/0040_properties.sql).
-- T3's acceptance in SQL: an admin adds leaf_type with two values, and a forest
-- saved with it is accepted while one saved with a third value is not.
BEGIN;
SELECT plan(14);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000b0001', 'vocab-admin@example.com', 'x', 'admin'),
('00000000-0000-0000-0000-0000000b0002', 'vocab-player@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000b0001'), ('00000000-0000-0000-0000-0000000b0002');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000b0003',
 st_makeenvelope(60.0, 10.0, 60.2, 10.2, 4326),
 '00000000-0000-0000-0000-0000000b0002', 14);

-- the starter set ------------------------------------------------------
SELECT ok((SELECT count(*) FROM kind) >= 6, 'the world starts with a vocabulary');
SELECT is((SELECT geometry FROM kind WHERE name = 'road'), 'line',
    'a road is drawn as a line');
SELECT ok((SELECT count(*) FROM property WHERE kind = 'footprint') >= 4,
    'a building can say how tall it is and what its roof is');

-- kind is a table now, not a CHECK ---------------------------------------
SELECT is((SELECT count(*)::int FROM pg_constraint
           WHERE conrelid = 'feature'::regclass AND conname = 'feature_kind_check'),
    0, 'kind is no longer five words in a CHECK');
SELECT col_is_fk('public', 'feature', 'kind', 'a feature names a kind that exists');

-- only an admin defines ---------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000b0002","role":"player"}';
SET LOCAL role = 'player';
SELECT throws_ok($$SELECT put_property('forest', 'invented', 'text')$$,
    '42501', NULL, 'a player does not get to invent properties');
SELECT throws_ok($$SELECT put_kind('shed')$$,
    '42501', NULL, 'nor kinds');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000b0001","role":"admin"}';
SELECT lives_ok(
    $$SELECT put_property('forest', 'leaf_type', 'choice',
        ARRAY['needleleaved', 'broadleaved'], false, 'Leaves')$$,
    'the admin says what a wood may say about its leaves');
SELECT is((SELECT array_to_string(choices, ',') FROM property
           WHERE kind = 'forest' AND name = 'leaf_type'),
    'needleleaved,broadleaved', 'with the two values they chose');

-- and the world is held to it --------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000b0002","role":"player"}';
SELECT lives_ok($$INSERT INTO feature (area_id, kind, geom, props) VALUES (
        '00000000-0000-0000-0000-0000000b0003', 'forest',
        st_force3d(st_makeenvelope(60.01, 10.01, 60.02, 10.02, 4326)),
        '{"leaf_type": "broadleaved"}')$$,
    'a wood of broadleaves is a wood');
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom, props) VALUES (
        '00000000-0000-0000-0000-0000000b0003', 'forest',
        st_force3d(st_makeenvelope(60.03, 10.03, 60.04, 10.04, 4326)),
        '{"leaf_type": "plastic"}')$$,
    NULL, NULL, 'and plastic leaves are not one of the two');
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom, props) VALUES (
        '00000000-0000-0000-0000-0000000b0003', 'footprint',
        st_force3d(st_makeenvelope(60.05, 10.05, 60.06, 10.06, 4326)),
        '{"height": "quite tall"}')$$,
    NULL, NULL, 'a height is a number');
SELECT lives_ok($$INSERT INTO feature (area_id, kind, geom, props) VALUES (
        '00000000-0000-0000-0000-0000000b0003', 'forest',
        st_force3d(st_makeenvelope(60.07, 10.07, 60.08, 10.08, 4326)),
        '{"planted_by": "grandfather"}')$$,
    'a property nobody defined is still allowed: the vocabulary grows by use');

-- what a form asks for ----------------------------------------------------
SELECT is(
    (SELECT jsonb_array_length(k -> 'properties')
     FROM jsonb_array_elements(vocabulary('feature')) k
     WHERE k ->> 'name' = 'forest'),
    (SELECT count(*)::int FROM property WHERE kind = 'forest'),
    'vocabulary() hands a form every property of a kind');

ROLLBACK;
