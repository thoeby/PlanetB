"""Layers that are already tables in a PostgreSQL database.

The same shape as `geoserver.probe()` — {name, title, bbox, fields} per layer —
so the import page offers both the same way, and `importer.load_layer()` reads
one as GeoJSON with `st_asgeojson` instead of over WFS. Nothing is copied to
disk on the way: a table is read, reprojected to 4326 and inserted.

The world's own tables are not layers to import: `area`, `feature`, `instance`
and `tile` are the world, and offering them would invite importing the world
into itself.
"""
from __future__ import annotations

import psycopg
from psycopg import sql

from .config import Config

OURS = ("area", "feature", "instance", "tile")
SKIP_SCHEMAS = ("information_schema", "pg_catalog", "topology", "tiger", "gis", "api")


def dsn_for(cfg: Config, spec: dict | None = None) -> str:
    """This world's database, or another one the spec names."""
    spec = spec or {}
    if spec.get("dsn"):
        return str(spec["dsn"])
    return cfg.dsn(spec.get("database")) if spec.get("database") else cfg.dsn()


def layers(cfg: Config, spec: dict | None = None) -> list[dict]:
    """Every spatial table, with its columns, for the page to offer."""
    out: list[dict] = []
    with psycopg.connect(dsn_for(cfg, spec), autocommit=True, connect_timeout=10) as conn:
        rows = conn.execute(
            "SELECT f_table_schema, f_table_name, f_geometry_column, srid, type"
            " FROM geometry_columns"
            " WHERE f_table_schema <> ALL(%s) AND f_table_name <> ALL(%s)"
            " ORDER BY f_table_schema, f_table_name",
            (list(SKIP_SCHEMAS), list(OURS))).fetchall()
        for schema, table, geom, srid, gtype in rows:
            out.append({
                "name": f"{schema}.{table}",
                "title": f"{table} ({gtype.lower()})",
                "geometry_type": gtype,
                "srid": srid,
                "geometry_column": geom,
                "fields": fields(conn, schema, table, geom),
                "bbox": extent(conn, schema, table, geom),
            })
    return out


def fields(conn, schema: str, table: str, geom: str) -> list[str]:
    """The columns a mapping can point at — everything but the geometry."""
    rows = conn.execute(
        "SELECT column_name FROM information_schema.columns"
        " WHERE table_schema = %s AND table_name = %s AND column_name <> %s"
        " ORDER BY ordinal_position", (schema, table, geom)).fetchall()
    return [r[0] for r in rows]


def extent(conn, schema: str, table: str, geom: str) -> list[float] | None:
    """The layer's extent in degrees, so the page can fill the region in."""
    query = sql.SQL(
        "SELECT st_xmin(e), st_ymin(e), st_xmax(e), st_ymax(e) FROM ("
        " SELECT st_extent(st_transform({geom}, 4326))::geometry AS e FROM {tbl}) s"
    ).format(geom=sql.Identifier(geom), tbl=sql.Identifier(schema, table))
    try:
        row = conn.execute(query).fetchone()
    except psycopg.Error:
        return None  # an unprojectable or empty table is still a layer
    return [float(v) for v in row] if row and row[0] is not None else None


def as_geojson(cfg: Config, spec: dict) -> dict:
    """One table as a GeoJSON FeatureCollection, in 4326, like WFS returns."""
    name = str(spec.get("table") or "")
    schema, _, table = name.rpartition(".")
    if not table:
        raise SystemExit(f"{spec.get('name', name)}: \"table\" wants schema.table")
    with psycopg.connect(dsn_for(cfg, spec), autocommit=True, connect_timeout=10) as conn:
        geom = spec.get("geometry_column") or geometry_column(conn, schema or "public", table)
        query = sql.SQL(
            "SELECT jsonb_build_object('type', 'FeatureCollection', 'features',"
            " coalesce(jsonb_agg(jsonb_build_object("
            "   'type', 'Feature',"
            "   'geometry', st_asgeojson(st_transform(t.{geom}, 4326))::jsonb,"
            "   'properties', to_jsonb(t) - {geomname})), '[]'::jsonb))"
            " FROM {tbl} t WHERE t.{geom} IS NOT NULL"
        ).format(geom=sql.Identifier(geom), geomname=sql.Literal(geom),
                 tbl=sql.Identifier(schema or "public", table))
        return conn.execute(query).fetchone()[0]


def geometry_column(conn, schema: str, table: str) -> str:
    row = conn.execute(
        "SELECT f_geometry_column FROM geometry_columns"
        " WHERE f_table_schema = %s AND f_table_name = %s", (schema, table)).fetchone()
    if not row:
        raise SystemExit(f"{schema}.{table} has no geometry column")
    return row[0]
