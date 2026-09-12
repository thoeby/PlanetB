-- Land you have just been given is ground (db/0064_claimingrendersnothing.sql).
BEGIN;
SELECT plan(3);

INSERT INTO auth.user (id, email, pw_hash, role, name) VALUES
('00000000-0000-0000-0000-00000000f501', 'anna@example.com', 'x', 'admin', 'Anna');
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8081/geoserver', 'splatworld:visp',
        st_makeenvelope(7.8545, 46.2759, 7.9085, 46.3119, world_srid()),
        '00000000-0000-0000-0000-00000000f501');
DELETE FROM tile;

INSERT INTO area (id, geom, owner_id, detail)
VALUES ('00000000-0000-0000-0000-0000000000c1',
        st_geomfromtext('POLYGON((7.876 46.291, 7.883 46.291, 7.883 46.296,'
                        ' 7.876 46.296, 7.876 46.291))', world_srid()),
        '00000000-0000-0000-0000-00000000f501', 14);

SELECT cmp_ok((SELECT count(*) FROM tile), '>', 0::bigint,
              'the land has tiles: they are what a compile attaches to');
SELECT is((SELECT count(*) FROM tile WHERE dirty), 0::bigint,
          'and not one of them is waiting for anything');

-- A boundary that moves is a different story: what was compiled under the old
-- one was compiled from the old one.
UPDATE area SET geom = st_translate(geom, 0.001, 0)
WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT cmp_ok((SELECT count(*) FROM tile WHERE dirty), '>', 0::bigint,
              'moving the boundary is a change');

SELECT * FROM finish();
ROLLBACK;
