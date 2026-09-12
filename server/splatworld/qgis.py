"""The QGIS project, written from the world's own vocabulary.

`gis/splatworld.qgs` holds a layer per thing people draw, with a form on each
showing the properties an admin defined and a dropdown wherever they listed the
values. The layers are PostgreSQL layers: QGIS connects to the world's database
as the player, with the login the Land panel hands them
(db/0065_playerroles.sql), and row-level security decides what they may draw
exactly as it does in the browser.

It went over WFS-T through GeoServer until then, as one operator with
BYPASSRLS, and everything about drawing that has ever broken — axis order,
placeholders for blanks, read-only views, who owns what you drew — came from
that (REFACTOR-direct-pg.md).

It is generated rather than hand-kept because the vocabulary is not ours to
fix: `splatworld qgis` rewrites the file from `gis_layers()`, so a kind added
this morning is a layer this afternoon. The committed copy names a pg_service
entry instead of a password; the one the page hands you carries your own.
"""
from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path

import psycopg

from . import crs as world
from .config import Config

# QGIS writes the version it saved with; it opens anything from 3.x.
QGIS_VERSION = "3.34.0-Prizren"

GEOMETRY_NAMES = {"polygon": "Polygon", "line": "Line", "point": "Point"}

# What the provider is told the column holds. The views are MultiPolygon and
# MultiLineString (db/0057), and a point is a point.
PG_GEOMETRY = {"polygon": "MultiPolygon", "line": "MultiLineString",
               "point": "Point"}


def _sub(parent, tag, text=None, **attrs):
    node = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        node.text = text
    return node


def crs(parent, tag: str = "srs"):
    holder = _sub(parent, tag)
    srs = _sub(holder, "spatialrefsys")
    _sub(srs, "wkt", world.QGIS_WKT)
    _sub(srs, "proj4", world.QGIS_PROJ4)
    _sub(srs, "srsid", world.QGIS_SRSID)
    _sub(srs, "srid", str(world.WORLD_SRID))
    _sub(srs, "authid", world.WORLD)
    _sub(srs, "description", "WGS 84")
    _sub(srs, "projectionacronym", "longlat")
    _sub(srs, "ellipsoidacronym", world.QGIS_ELLIPSOID)
    _sub(srs, "geographicflag", "true")
    return holder


def pg_source(conn: dict, layer: dict) -> str:
    """What QGIS needs to open one PostgreSQL layer.

    `key='id'` because these are views with INSTEAD OF triggers: the provider
    has no primary key to find and will not edit without being told which
    column identifies a row. checkPrimaryKeyUnicity='0' stops it counting the
    whole table to prove that key is unique.

    With no password the datasource names a pg_service entry instead, which is
    what the committed gis/splatworld.qgs holds: a project in a repository must
    not carry anybody's credentials.
    """
    shape = PG_GEOMETRY.get(layer.get("geometry", "polygon"), "MultiPolygon")
    where = (f"service='{conn['service']}'" if not conn.get("password")
             else (f"dbname='{conn['dbname']}' host={conn['host']} "
                   f"port={conn['port']} user='{conn['user']}' "
                   f"password='{conn['password']}' sslmode=prefer"))
    return (f"{where} key='id' srid={world.WORLD_SRID} type={shape} "
            f"checkPrimaryKeyUnicity='0' "
            f'table="gis"."{layer["layer"]}" (geom)')


def value_map(field, choices: list[str]) -> None:
    """A dropdown of exactly the values the admin listed."""
    widget = _sub(field, "editWidget", type="ValueMap")
    config = _sub(widget, "config")
    options = _sub(config, "Option", type="Map")
    values = _sub(options, "Option", name="map", type="List")
    for choice in choices:
        entry = _sub(values, "Option", type="Map")
        _sub(entry, "Option", name=choice, value=choice, type="QString")


def field_config(layer_node, fields: list[dict]) -> None:
    configuration = _sub(layer_node, "fieldConfiguration")
    aliases = _sub(layer_node, "aliases")
    constraints = _sub(layer_node, "constraints")
    for index, field in enumerate(fields):
        node = _sub(configuration, "field", name=field["name"], configurationFlags="None")
        if field["type"] == "choice" and field.get("choices"):
            value_map(node, list(field["choices"]))
        else:
            kind = {"number": "Range", "boolean": "CheckBox"}.get(field["type"], "TextEdit")
            widget = _sub(node, "editWidget", type=kind)
            _sub(widget, "config")
        _sub(aliases, "alias", field=field["name"], name=field["label"], index=index)
        _sub(constraints, "constraint", field=field["name"],
             constraints=1 if field.get("required") else 0,
             notnull_strength=1 if field.get("required") else 0,
             unique_strength=0, exp_strength=0)


# TASKS-usable T8: right-click a piece of land in QGIS and stand on it. The
# expression is evaluated by QGIS per feature; the link is the same one the
# Share panel writes (client/js/visit.js).
def visit_action(node, app_url: str, ident: str) -> None:
    actions = _sub(node, "attributeactions", default="0")
    at = ("[% format('%1,%2', y(centroid($geometry)), x(centroid($geometry))) %]")
    setting = _sub(actions, "actionsetting",
                   type=5, name="Visit in splatworld", shortTitle="Visit",
                   action=f"{app_url}#at={at}", capture="0", icon="",
                   isEnabledOnlyWhenEditable="0", notificationMessage="",
                   id="{" + hashlib.md5(f"visit:{ident}".encode()).hexdigest() + "}")
    _sub(setting, "actionScope", id="Feature")
    _sub(setting, "actionScope", id="Canvas")


def map_layer(parent, layer: dict, conn: dict, app_url: str = "") -> str:
    # A stable id: Python's hash() is salted per process, and a project file
    # that changes on every run is not a file anybody can keep in a repo.
    digest = hashlib.md5(layer["layer"].encode()).hexdigest()[:12]
    ident = f"{layer['layer']}_{digest}"
    node = _sub(parent, "maplayer", type="vector", hasScaleBasedVisibilityFlag="0",
                geometry=GEOMETRY_NAMES.get(layer["geometry"], "Polygon"),
                readOnly="1" if layer.get("read_only") else "0")
    _sub(node, "id", ident)
    _sub(node, "datasource", pg_source(conn, layer))
    _sub(node, "layername", layer["label"])
    crs(node)
    _sub(node, "provider", "postgres", encoding="UTF-8")
    field_config(node, layer.get("fields") or [])
    if app_url:
        visit_action(node, app_url, ident)
    return ident


def raster_layer(parent, wms_url: str, coverage: str) -> str:
    """The ground, as a picture to draw on: the same coverage, over WMS."""
    ident = "ground_hillshade"
    node = _sub(parent, "maplayer", type="raster", hasScaleBasedVisibilityFlag="0")
    _sub(node, "id", ident)
    _sub(node, "datasource",
         f"crs={world.WORLD}&format=image/png&layers={coverage}&styles=&url={wms_url}")
    _sub(node, "layername", f"Ground ({coverage})")
    crs(node)
    _sub(node, "provider", "wms")
    return ident


def project_xml(layers: list[dict], conn: dict, wms_url: str,
                coverage: str | None, app_url: str = "") -> bytes:
    root = ET.Element("qgis", {"projectname": "splatworld", "version": QGIS_VERSION})
    _sub(root, "homePath", path="")
    _sub(root, "title", "splatworld")
    crs(root, "projectCrs")

    tree = _sub(root, "layer-tree-group")
    project_layers = _sub(root, "projectlayers")
    order = _sub(root, "layerorder")

    entries: list[tuple[str, str, str]] = []
    for layer in layers:
        ident = map_layer(project_layers, layer, conn)
        entries.append((ident, layer["label"], pg_source(conn, layer)))
    # Land is assigned, not drawn (SPEC §3.2), and the tiles are the world's
    # own bookkeeping: both are there to see, neither to edit.
    for name, layer_name, shape, editable in (
            ("Your land", "area", "polygon", False),
            ("Placed", "instance", "point", True),
            ("Tiles", "tile", "polygon", False)):
        spec = {"layer": layer_name, "label": name, "geometry": shape,
                "fields": [], "read_only": not editable}
        ident = map_layer(project_layers, spec, conn,
                          app_url if layer_name == "area" else "")
        entries.append((ident, name, pg_source(conn, spec)))
    if coverage:
        ident = raster_layer(project_layers, wms_url, coverage)
        entries.append((ident, f"Ground ({coverage})", ""))

    # Drawing order is the order they are listed: the ground underneath.
    for ident, name, source in entries:
        _sub(tree, "layer-tree-layer", id=ident, name=name, source=source,
             providerKey="postgres" if source else "wms", checked="Qt::Checked",
             expanded="1")
        _sub(order, "layer", id=ident)

    ET.indent(root, space="  ")
    return (b'<?xml version="1.0" encoding="UTF-8"?>\n'
            + ET.tostring(root, encoding="utf8", xml_declaration=False))


# The committed project names a pg_service entry; gis/README.md says what to
# put in it. Nothing in the repository carries a password.
SERVICE = "splatworld"


def connection(cfg: Config, role: str | None = None,
               password: str | None = None) -> dict:
    """How QGIS reaches this database: as a named service, or as one player."""
    if not password:
        return {"service": SERVICE}
    host = "127.0.0.1" if cfg.pg_host in ("0.0.0.0", "::") else cfg.pg_host
    return {"dbname": cfg.pg_database, "host": host, "port": cfg.pg_port,
            "user": role, "password": password}


def build(cfg: Config, conn: dict, app_url: str | None = None) -> bytes:
    """The project file, from what the world says it holds."""
    with psycopg.connect(cfg.dsn(), autocommit=True) as db:
        layers = db.execute("SELECT gis_layers()").fetchone()[0]
        row = db.execute("SELECT geoserver_url, coverage FROM ground").fetchone()
    base = (row[0] if row else cfg.geoserver_url) or "http://localhost:8080/geoserver"
    base = base.rstrip("/")
    if not base.startswith("http"):
        base = f"http://{base}"
    host = "127.0.0.1" if cfg.host in ("0.0.0.0", "::") else cfg.host
    return project_xml(layers, conn, f"{base}/wms", row[1] if row else None,
                       app_url or f"http://{host}:{cfg.port}/app/play.html")


def write(cfg: Config, out: Path | None = None) -> Path:
    """Rewrites gis/splatworld.qgs from what the world says it holds."""
    target = out or (cfg.repo / "gis" / "splatworld.qgs")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(build(cfg, connection(cfg)))
    return target
