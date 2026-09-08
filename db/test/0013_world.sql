-- tile_world hands an atom exactly what its job was built from: the features
-- and instances touching the tile, and the snapshot hash over them
-- (db/0013_world.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000d3001', 'world@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-0000000d3001');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000d3002',
 st_makeenvelope(50.0, 50.0, 50.4, 50.4, 4326),
 '00000000-0000-0000-0000-0000000d3001', 14);
INSERT INTO feature (id, area_id, kind, geom, props) VALUES
('00000000-0000-0000-0000-0000000d3003', '00000000-0000-0000-0000-0000000d3002',
 'footprint', st_force3d(st_makeenvelope(50.01, 50.01, 50.011, 50.011, 4326)),
 '{"height": 12}'::jsonb),
('00000000-0000-0000-0000-0000000d3004', '00000000-0000-0000-0000-0000000d3002',
 'forest', st_force3d(st_makeenvelope(50.3, 50.3, 50.31, 50.31, 4326)), '{}'::jsonb);

CREATE TEMP TABLE spot AS
SELECT tile_x(50.0105, 14) AS x, tile_y(50.0105, 14) AS y;

SELECT is(jsonb_array_length(
    (SELECT tile_world(14, x, y) -> 'features' FROM spot)), 1,
    'only the feature that touches the tile comes back');
SELECT is(
    (SELECT tile_world(14, x, y) -> 'features' -> 0 ->> 'kind' FROM spot),
    'footprint', 'with its kind');
SELECT is(
    (SELECT tile_world(14, x, y) -> 'features' -> 0 -> 'props' ->> 'height' FROM spot),
    '12', 'and its props');
SELECT is(
    (SELECT tile_world(14, x, y) -> 'features' -> 0 -> 'geom' ->> 'type' FROM spot),
    'Polygon', 'geometry arrives as GeoJSON, not as hex');
SELECT is(
    (SELECT tile_world(14, x, y) ->> 'snapshot' FROM spot),
    (SELECT world_snapshot(14, x, y) FROM spot),
    'the snapshot is the one build_dag hashed');
SELECT is(jsonb_array_length(
    (SELECT tile_world(14, x, y) -> 'instances' FROM spot)), 0,
    'no instances here, and an empty array rather than null');

SELECT * FROM finish();
ROLLBACK;
