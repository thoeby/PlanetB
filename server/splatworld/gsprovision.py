"""Sets your GeoServer up as the drawing surface for the world.

This is infra/geoserver/provision.sh without the bash, so it runs on Windows.
It talks to GeoServer's REST API and makes it publish the editable layers that
live in this world's database:

    feature_road  feature_forest  feature_water  feature_footprint
    feature_terrainmod  area  instance          tile (read-only, compile state)

Then QGIS edits them over WFS-T and a database trigger marks the covering tiles
dirty, which is the work queue. GeoServer is admin and visualisation only and
is never the app API (Invariant 9); the browser talks to PostgREST.

Idempotent — objects that already exist come back 401/409 and are left alone.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

from .config import Config
from .importer import absolute_url

WORKSPACE = "splatworld"
STORE = "splatworld_pg"
LAYERS = ("feature_road", "feature_forest", "feature_water", "feature_footprint",
          "feature_terrainmod", "area", "instance", "tile")
STYLES = ("tile", "area")


class GeoServer:
    def __init__(self, url: str, user: str, password: str):
        self.base = absolute_url(url).rstrip("/")
        if not self.base.endswith("/geoserver"):
            self.base += "/geoserver"
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        self.auth = f"Basic {token}"

    def call(self, method: str, path: str, body: bytes | None = None,
             content_type: str = "application/xml") -> int:
        request = urllib.request.Request(
            f"{self.base}{path}", data=body, method=method,
            headers={"Authorization": self.auth, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=60) as res:
                return res.status
        except urllib.error.HTTPError as err:
            # 401 and 409 are what GeoServer says for "that is already there",
            # which is the normal answer on a second run.
            if err.code in (401, 409):
                return err.code
            detail = err.read()[:300].decode("utf8", "replace")
            raise SystemExit(
                f"geoserver: {method} {path} was refused ({err.code} {err.reason}).\n"
                f"  {detail}\n"
                f"  Address tried: {self.base}\n"
                "  Wrong admin password gives 401 on the very first call; a wrong\n"
                "  address usually gives 404."
            ) from err
        except OSError as err:
            raise SystemExit(
                f"geoserver: could not reach {self.base} — {err}\n"
                "  Is GeoServer running, and is that its address?"
            ) from err


def store_body(cfg: Config, db_host: str, db_password: str) -> bytes:
    """GeoServer connection keys contain spaces, so this goes as JSON."""
    entries = {
        "host": db_host, "port": str(cfg.pg_port), "database": cfg.pg_database,
        "user": "geoserver", "passwd": db_password, "dbtype": "postgis",
        "schema": "gis", "Expose primary keys": "true",
        "validate connections": "true",
    }
    return json.dumps({"dataStore": {"name": STORE, "connectionParameters": {
        "entry": [{"@key": k, "$": v} for k, v in entries.items()]}}}).encode()


def provision(cfg: Config, url: str, user: str, password: str,
              db_host: str | None = None, on_step=print) -> str:
    gs = GeoServer(url, user, password)
    # GeoServer reaches the database itself, so "localhost" is only right when
    # they are the same machine — which they usually are, and rarely are not.
    host = db_host or (cfg.pg_host if cfg.pg_host not in ("", "localhost")
                       else "localhost")

    on_step(f"  workspace {WORKSPACE}")
    gs.call("POST", "/rest/workspaces",
            f"<workspace><name>{WORKSPACE}</name></workspace>".encode())

    on_step(f"  database store on {host}:{cfg.pg_port}/{cfg.pg_database}, schema gis")
    gs.call("POST", f"/rest/workspaces/{WORKSPACE}/datastores",
            store_body(cfg, host, cfg.geoserver_password), "application/json")

    for layer in LAYERS:
        on_step(f"  layer {layer}")
        gs.call("POST",
                f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}/featuretypes",
                f"<featureType><name>{layer}</name>"
                f"<srs>EPSG:4326</srs></featureType>".encode())

    styles_dir = cfg.repo / "infra" / "geoserver" / "styles"
    for style in STYLES:
        sld = styles_dir / f"{style}.sld"
        if not sld.is_file():
            continue
        on_step(f"  style {style}")
        gs.call("POST", f"/rest/workspaces/{WORKSPACE}/styles?name={style}",
                sld.read_bytes(), "application/vnd.ogc.sld+xml")
        gs.call("PUT", f"/rest/layers/{WORKSPACE}:{style}",
                f"<layer><defaultStyle><name>{WORKSPACE}:{style}</name>"
                f"</defaultStyle></layer>".encode())

    # Drawing is a WFS transaction, and transactions need service level COMPLETE.
    on_step("  turning on WFS transactions")
    gs.call("PUT", "/rest/services/wfs/settings",
            b"<wfs><enabled>true</enabled><serviceLevel>COMPLETE</serviceLevel>"
            b"<maxFeatures>50000</maxFeatures></wfs>")

    return f"{gs.base}/{WORKSPACE}/wfs"


def write_qgis_connection(target: Path, wfs_url: str) -> Path:
    """A file QGIS loads instead of being told the address by hand."""
    target.write_text(
        '<!DOCTYPE connections>\n<qgsWFSConnections version="1.0">\n'
        f'  <wfs name="splatworld" url="{wfs_url}" version="auto"\n'
        '       ignoreAxisOrientation="0" invertAxisOrientation="0"\n'
        '       pagingEnabled="true" preferCoordinatesForWfsT11="false"/>\n'
        '</qgsWFSConnections>\n', encoding="utf8")
    return target
