-- What build mode asks before it writes: which areas are mine, who owns the
-- ground under a point, and what the tiles there owe (db/0021_build.sql).
-- Also that tile_world now names the GLB an instance stands on.
BEGIN;
SELECT plan(17);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000d1001', 'build-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000d1002', 'build-grantee@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000d1003', 'build-stranger@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000d1001'), ('00000000-0000-0000-0000-0000000d1002'),
('00000000-0000-0000-0000-0000000d1003');

INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000d2001',
 st_makeenvelope(20.0, 20.0, 20.2, 20.2, 4326),
 '00000000-0000-0000-0000-0000000d1001', 14);
INSERT INTO grant_ (area_id, grantee_id, right_) VALUES
('00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d1002', 'edit');

-- ------------------------------------------------------------------ my_areas

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d1001","role":"player"}';
SELECT is(jsonb_array_length(my_areas()), 1, 'the owner sees their area');
SELECT is(my_areas() -> 0 ->> 'may_write', 'true', 'and may write in it');
SELECT is(my_areas() -> 0 ->> 'mine', 'true', 'and it says so');
SELECT is((my_areas() -> 0 -> 'centre' ->> 'lon')::numeric, 20.1::numeric,
          'the centre is where the panel flies to');

-- An `edit` grant proposes, it does not write. WP4.3 is what turns that into a
-- proposal; here it only has to be told apart from a writer.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d1002","role":"player"}';
SELECT is(jsonb_array_length(my_areas()), 1, 'the grantee sees it too');
SELECT is(my_areas() -> 0 ->> 'may_write', 'false', 'but may not write');
SELECT is(my_areas() -> 0 ->> 'may_propose', 'true', 'only propose');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d1003","role":"player"}';
SELECT is(jsonb_array_length(my_areas()), 0, 'a stranger has nowhere to build');

-- ------------------------------------------------------------------- area_at

SELECT is(jsonb_array_length(area_at(20.1, 20.1)), 1,
          'a stranger still sees whose land it is');
SELECT is(area_at(20.1, 20.1) -> 0 ->> 'may_write', 'false',
          'and that it is not theirs to build on');
SELECT is(jsonb_array_length(area_at(0.0, 0.0)), 0, 'open sea has no area');

-- ------------------------------------------------------------------ tiles_at

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d1001","role":"player"}';
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000d2001', 'footprint',
 st_setsrid(st_makepoint(20.1, 20.1, 300), 4326));

SELECT is(jsonb_array_length(tiles_at(20.1, 20.1, 14)), 5,
          'z6 to z14 over the point the feature dirtied');
SELECT is(tiles_at(20.1, 20.1, 14) -> 0 ->> 'dirty', 'true',
          'and the badge says dirty');
SELECT is((tiles_at(20.1, 20.1, 14) -> 0 ->> 'z')::int, 6, 'coarse first');
SELECT is(tiles_at(20.1, 20.1, 14) -> 0 ->> 'job_id', null,
          'with no job until ensure_job opens one');

-- ---------------------------------------------------------------- tile_world

-- An instance names a SAN; `assemble` needs the digest of the canonical GLB
-- behind it, which is what 0021 added to tile_world.
CREATE TEMP TABLE placed AS
SELECT register_artifact(repeat('c', 64), 'glb', 4096, 'canon-v1') AS glb;
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris, tex_bytes,
                   license, creator_id)
VALUES (derive_san(repeat('c', 64)), repeat('c', 64), 1, 'Bench', 'furniture',
        '{"min":[-0.9,0,-0.25],"max":[0.9,0.5,0.25]}'::jsonb, 36, 0, 'cc0',
        '00000000-0000-0000-0000-0000000d1001');
INSERT INTO instance (area_id, san, lon, lat, h)
VALUES ('00000000-0000-0000-0000-0000000d2001', derive_san(repeat('c', 64)),
        20.1, 20.1, 300);

SELECT is(jsonb_array_length(tile_world(14, tile_x(20.1, 14), tile_y(20.1, 14))
              -> 'instances'), 1, 'the tile knows what stands in it');
SELECT is(tile_world(14, tile_x(20.1, 14), tile_y(20.1, 14))
              -> 'instances' -> 0 ->> 'sha256', repeat('c', 64),
          'and which bytes to place');

SELECT * FROM finish();
ROLLBACK;
