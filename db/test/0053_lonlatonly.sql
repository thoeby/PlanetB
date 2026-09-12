-- A 4326 column holds longitude and latitude: Mercator is converted when it
-- can be, and refused when it cannot (db/0053_lonlatonly.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000e1001', 'lonlat@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-0000000e1001');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000e1002',
 st_makeenvelope(7.8, 46.2, 8.0, 46.4, 4326),
 '00000000-0000-0000-0000-0000000e1001', 14);

-- Drawn in Web Mercator and sent as such: converted, not refused.
INSERT INTO feature (id, area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000e1003',
 '00000000-0000-0000-0000-0000000e1002', 'forest',
 st_setsrid(st_makeenvelope(875662, 5826336, 878108, 5828782, 3857), 3857));

SELECT ok((SELECT st_xmax(geom) < 180 AND st_ymax(geom) < 90 FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000e1003'),
          'a geometry sent in Mercator is stored as longitude and latitude');
SELECT is((SELECT st_srid(geom)::int FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000e1003'), 4326,
          'and carries 4326');
SELECT ok((SELECT abs(st_xmin(geom) - 7.87) < 0.1 FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000e1003'),
          'in the place it was drawn, not somewhere else');

-- The same numbers labelled 4326: nothing can convert those, and storing them
-- is what made a whole layer unopenable.
SELECT throws_ok(
    $$INSERT INTO feature (area_id, kind, geom) VALUES
      ('00000000-0000-0000-0000-0000000e1002', 'forest',
       st_setsrid(st_makeenvelope(875662, 5826336, 878108, 5828782, 4326), 4326))$$,
    '22023', null, 'Mercator metres labelled 4326 are refused, not stored');

-- A geometry with no SRID at all is lon/lat by declaration, as it always was.
INSERT INTO feature (id, area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000e1004',
 '00000000-0000-0000-0000-0000000e1002', 'forest',
 st_makeenvelope(7.85, 46.25, 7.86, 46.26));
SELECT is((SELECT st_srid(geom)::int FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000e1004'), 4326,
          'an unset SRID is taken as longitude and latitude');

SELECT is(st_srid(as_lonlat(null)), null, 'and nothing is still nothing');

SELECT * FROM finish();
ROLLBACK;
