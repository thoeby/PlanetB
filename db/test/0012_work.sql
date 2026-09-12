-- my_dirty_tiles lists the dirty tiles inside areas the caller may write, with
-- the open job for each where one exists (db/0012_work.sql).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000c2001', 'work-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000c2002', 'work-stranger@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000c2001'), ('00000000-0000-0000-0000-0000000c2002');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000c2003',
 st_envelope(st_buffer(tile_bbox(10, tile_x(40.1, 10), tile_y(40.1, 10)), -0.002)),
 '00000000-0000-0000-0000-0000000c2001', 10);
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000c2003', 'forest',
 st_force3d(st_envelope(st_buffer(tile_bbox(10, tile_x(40.1, 10), tile_y(40.1, 10)), -0.05))));

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c2001","role":"player"}';
SET LOCAL role = 'player';

SELECT is((SELECT count(*) FROM my_dirty_tiles(50)), 3::bigint,
          'the owner sees the three tiles their feature dirtied');
SELECT is((SELECT array_agg(z ORDER BY z) FROM my_dirty_tiles(50)),
          ARRAY[6, 8, 10]::smallint [],
          'z6 to the area''s detail, and no deeper');
SELECT is((SELECT count(*) FROM my_dirty_tiles(1)), 1::bigint,
          'the limit is honoured');
SELECT is((SELECT count(*) FROM my_dirty_tiles(50) WHERE job_id IS NOT NULL), 0::bigint,
          'no job is open yet');

CREATE TEMP TABLE opened AS
SELECT ensure_job(t.z, t.x, t.y) AS job FROM my_dirty_tiles(50) t WHERE t.z = 10;
SELECT is((SELECT job_id FROM my_dirty_tiles(50) WHERE z = 10),
          (SELECT job FROM opened),
          'once a job is open for the tile''s version, it is named');

SELECT * FROM finish();
ROLLBACK;
