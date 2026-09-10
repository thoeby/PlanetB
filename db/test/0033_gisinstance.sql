BEGIN;
SELECT plan(3);

SELECT has_trigger('gis', 'instance', 'gis_instance_write', 'gis.instance is writable through a trigger');

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 100, 'canon-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id)
SELECT 'SPUJCSX4KZLJL', repeat('a', 64), 1, 'pine', 'tree', '{}'::jsonb, 10, 0,
       'cc0', id FROM auth.user WHERE email = 'draw@example.com';

-- A point placed in QGIS: every column sent, blanks as 0.
INSERT INTO gis.instance (san, geom, h, yaw, pitch, roll, scale)
VALUES ('SPUJCSX4KZLJL', st_setsrid(st_makepoint(7.05, 46.05), 4326), 0, 0, 0, 0, 0);

SELECT is((SELECT (lon, lat, scale) FROM instance), (7.05::double precision, 46.05::double precision, 1::real),
          'the point became lon, lat, and a blank scale became 1');

UPDATE gis.instance SET geom = st_setsrid(st_makepoint(7.06, 46.06), 4326);
SELECT is((SELECT lon FROM instance), 7.06::double precision, 'moving the point moves the instance');

SELECT * FROM finish();
ROLLBACK;
