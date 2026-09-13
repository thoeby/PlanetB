-- 0071_thetileslayeropens.sql — the Tiles layer opens in QGIS.
--
-- gis.tile is the read-only overview layer: one rectangle per compile unit,
-- with what the world is waiting for on it. The project file tells the
-- PostgreSQL provider `key='id'`, because a view has no primary key to find and
-- the provider will not open one without being told which column identifies a
-- row (server/splatworld/qgis.py) — and this view had no id at all, so QGIS
-- opened the project with the layer greyed out and "Tiles" missing from the
-- map. Every other gis view already carries the id of the row behind it.
--
-- A tile's identity is z/x/y, so that is what the number says: z in the high
-- bits, then x, then y. Zoom is at most 18 and an index at that zoom is under
-- 2^18, so nothing collides and nothing overflows.
CREATE OR REPLACE VIEW gis.tile AS
SELECT
    t.z, t.x, t.y, t.dirty, t.expected_version, t.published_version,
    t.published_at,
    CASE
        WHEN t.published_version = 0 THEN 'unpublished'
        WHEN t.dirty THEN 'stale'
        ELSE 'current'
    END AS status,
    tile_bbox(t.z, t.x, t.y) AS geom,
    (t.z::bigint << 40) | (t.x::bigint << 20) | t.y::bigint AS id
FROM tile t;
