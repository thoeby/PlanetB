-- 0066_dropproxy.sql — the GeoServer proxy in front of Postgres is gone.
--
-- REFACTOR-direct-pg.md S5. QGIS now connects to this database as the player
-- (db/0065_playerroles.sql), so the one login with BYPASSRLS that every drawn
-- row came through has nothing left to do. GeoServer keeps its other half —
-- it publishes the operator's elevation over WCS, which is the only way
-- terabytes of DEM work — and is asked for nothing else.
--
-- The GRANTs to `geoserver` in db/0008 onwards are left where they are: they
-- are history, and a grant to a role that no longer exists goes with it.

DROP TABLE IF EXISTS gis.gt_pk_metadata;

-- gis.default_owner() answered "whose land does this become" for a login that
-- carried no person. It answers current_user_id() now (0065), and the guess it
-- used to make is not a thing the world has to say any more.
DROP FUNCTION IF EXISTS drawing_as();
DROP FUNCTION IF EXISTS api.drawing_as();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geoserver') THEN
        -- A role cannot be dropped while anything it was granted still points
        -- at it; REASSIGN/DROP OWNED clears the grants this schema made.
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public, gis FROM geoserver';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, gis FROM geoserver';
        EXECUTE 'REVOKE ALL ON SCHEMA public, gis FROM geoserver';
        EXECUTE 'DROP OWNED BY geoserver';
        EXECUTE 'DROP ROLE geoserver';
    END IF;
END
$$;

-- The view rebuild granted to `geoserver` and kept a row in GeoServer's
-- primary-key table for every layer it made. Neither exists any more: the
-- grant goes to `player`, which is what QGIS connects as, and row-level
-- security decides the rest (Invariant 6).
CREATE OR REPLACE FUNCTION rebuild_gis_layers() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    k       record;
    columns text;
    view    text;
    n       int := 0;
BEGIN
    FOR view IN
        SELECT table_name FROM information_schema.views
        WHERE table_schema = 'gis' AND table_name LIKE 'f_%'
    LOOP
        EXECUTE format('DROP VIEW IF EXISTS gis.%I CASCADE', view);
    END LOOP;

    FOR k IN SELECT * FROM kind WHERE geometry IS NOT NULL AND applies_to = 'feature'
             ORDER BY ordering, name
    LOOP
        SELECT coalesce(string_agg(
            format('nullif(f.props ->> %L, %L)::%s AS %I',
                   p.name, '',
                   CASE p.type WHEN 'number' THEN 'double precision'
                               WHEN 'boolean' THEN 'boolean' ELSE 'text' END,
                   p.name), ', ' ORDER BY p.ordering, p.name), '')
        INTO columns FROM property p WHERE p.kind = k.name;

        EXECUTE format($view$
            CREATE VIEW gis.%I AS
            SELECT f.id, f.area_id, f.rev%s%s,
                   st_force2d(f.geom)::geometry(%s, 4326) AS geom
            FROM feature f
            WHERE f.kind = %L AND f.deleted_at IS NULL$view$,
            'f_' || k.name,
            CASE WHEN columns = '' THEN '' ELSE ', ' END, columns,
            gis_geometry_type(k.geometry), k.name);

        EXECUTE format(
            'CREATE TRIGGER write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.%I'
            ' FOR EACH ROW EXECUTE FUNCTION gis_kind_write(%L)',
            'f_' || k.name, k.name);

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON gis.%I TO player',
                       'f_' || k.name);
        n := n + 1;
    END LOOP;
    RETURN n;
END
$$;

SELECT rebuild_gis_layers();
