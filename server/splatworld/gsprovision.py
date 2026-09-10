"""Sets your GeoServer up as the drawing surface for the world.

This is infra/geoserver/provision.sh without the bash, so it runs on Windows.
It talks to GeoServer's REST API and makes it publish the editable layers that
live in this world's database:

    area  feature  instance          (the tables — writable, nothing to set)
    tile                             (read-only overview of compile state)

The tables, not views of them: a view has no primary key, so GeoTools serves
it read-only unless GeoServer is separately told where the keys are recorded,
and when that setting is missing QGIS says "area is read-only" at Save and
nothing explains why. A table's primary key is found on its own. db/0029 gives
the tables the defaults drawing needs.

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
from .importer import absolute_url, fetch

WORKSPACE = "splatworld"
STORE = "splatworld_pg"          # schema public: the tables QGIS draws into
OVERVIEW_STORE = "splatworld_gis"  # schema gis: the read-only tile overview
LAYERS = ("area", "feature", "instance")
OVERVIEW_LAYERS = ("tile",)
STYLES = ("tile", "area")


class GeoServer:
    def __init__(self, url: str, user: str, password: str):
        # Exactly the address given, minus the /web a browser shows. Where
        # GeoServer is mounted is a deployment choice — /geoserver is common but
        # the root is just as valid — so assuming /geoserver made every call
        # land on a 404 for anyone whose install is not the common one.
        self.base = absolute_url(url).rstrip("/")
        if self.base.lower().endswith("/web"):
            self.base = self.base[: -len("/web")]
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
            detail = err.read()[:300].decode("utf8", "replace")
            # "Already exists" is 409 from some GeoServer versions and a plain
            # 500 from others — the status cannot be trusted, so the sentence is
            # read instead. Either way it means the same thing: it is there, and
            # the caller should write its settings rather than give up.
            if err.code == 409 or "already exists" in detail.lower():
                return 409
            # 401 is not "already there": it means the admin password was
            # refused, and treating it as success reports a provisioning that
            # never happened and leaves an empty GeoServer.
            if err.code == 401:
                raise SystemExit(
                    f"geoserver: {self.base} refused the login.\n"
                    "  The admin user or password is wrong. Pass the right one:\n"
                    "    splatworld geoserver <address> --user admin --password <yours>\n"
                    "  GeoServer's own default is admin / geoserver, but any real\n"
                    "  installation will have changed it."
                ) from err
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

    def post_raw(self, path: str, body: bytes, content_type: str = "text/xml") -> bytes:
        """POST and hand back whatever came, status regardless — WFS reports its
        exceptions in the body, often with a 200."""
        request = urllib.request.Request(
            f"{self.base}{path}", data=body, method="POST",
            headers={"Authorization": self.auth, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=60) as res:
                return res.read()
        except urllib.error.HTTPError as err:
            return err.read()
        except OSError as err:
            raise SystemExit(f"geoserver: could not reach {self.base} — {err}") from err

    def read(self, path: str) -> dict:
        """What GeoServer actually holds, as opposed to what it was sent."""
        answer = fetch(f"{self.base}{path}",
                       {"Authorization": self.auth, "Accept": "application/json"},
                       what=f"reading {path}")
        try:
            return json.loads(answer)
        except ValueError:
            return {}


def featuretype_body(layer: str) -> bytes:
    """A layer GeoServer will actually serve, including when it holds no rows.

    GeoServer computes a feature type's bounding box from the data when it is
    published. A world is empty at exactly the moment it is being set up, so
    that computation finds nothing, the layer is left with no bounds, and WFS
    answers "Feature type is not available" — the layer is in the catalogue and
    unusable. Declaring the whole earth avoids depending on rows existing; the
    real extent is recomputed by GeoServer as data arrives.
    """
    whole_earth = {"minx": -180.0, "maxx": 180.0, "miny": -90.0, "maxy": 90.0,
                   "crs": "EPSG:4326"}
    return json.dumps({"featureType": {
        "name": layer,
        "nativeName": layer,
        "srs": "EPSG:4326",
        "nativeBoundingBox": whole_earth,
        "latLonBoundingBox": whole_earth,
        "projectionPolicy": "FORCE_DECLARED",
        "enabled": True,
    }}).encode()


def store_body(cfg: Config, db_host: str, db_password: str,
               name: str = STORE, schema: str = "public") -> bytes:
    """GeoServer connection keys contain spaces, so this goes as JSON."""
    entries = {
        "host": db_host, "port": str(cfg.pg_port), "database": cfg.pg_database,
        "user": "geoserver", "passwd": db_password, "dbtype": "postgis",
        "schema": schema, "Expose primary keys": "true",
        "validate connections": "true",
    }
    return json.dumps({"dataStore": {"name": name, "connectionParameters": {
        "entry": [{"@key": k, "$": v} for k, v in entries.items()]}}}).encode()


def check_store(gs: GeoServer, name: str, schema: str, on_step=print) -> None:
    """Confirm the store points where it was told to.

    Writing a store and having GeoServer accept it says nothing about what it
    kept; a store left over from an earlier attempt, aimed at another schema,
    publishes layers that cannot be read or written.
    """
    store = gs.read(f"/rest/workspaces/{WORKSPACE}/datastores/{name}.json")
    entries = store.get("dataStore", {}).get("connectionParameters", {}).get("entry", [])
    held = {e.get("@key"): e.get("$") for e in entries if isinstance(e, dict)}
    if held.get("schema") != schema:
        raise SystemExit(
            f"geoserver: the store {name} points at schema {held.get('schema')!r}, "
            f"not {schema}.\n"
            f"  Delete it under Data > Stores > {name} and press 'Set it up' again."
        )
    on_step(f"    settings confirmed: schema {schema}")


def ensure_store(gs: GeoServer, cfg: Config, host: str, name: str, schema: str,
                 layers: tuple[str, ...], on_step) -> None:
    on_step(f"  store {name}: {host}:{cfg.pg_port}/{cfg.pg_database}, schema {schema}")
    body = store_body(cfg, host, cfg.geoserver_password, name, schema)
    if gs.call("POST", f"/rest/workspaces/{WORKSPACE}/datastores",
               body, "application/json") == 409:
        # A store of that name already exists — but "exists" says nothing about
        # whether it points anywhere useful. One left over from an earlier
        # attempt, aimed at the wrong schema or host, publishes layers that
        # cannot be read, so its settings are written rather than trusted.
        on_step("    it was already there; writing the settings over it")
        gs.call("PUT", f"/rest/workspaces/{WORKSPACE}/datastores/{name}",
                body, "application/json")

    # GeoServer keeps live connection pools keyed by the store, and a store it
    # already has open is not necessarily reopened when its settings change. A
    # reset drops them, so what was just written is what the next request uses.
    gs.call("POST", "/rest/reset")
    check_store(gs, name, schema, on_step)

    for layer in layers:
        on_step(f"  layer {layer}")
        body = featuretype_body(layer)
        if gs.call("POST",
                   f"/rest/workspaces/{WORKSPACE}/datastores/{name}/featuretypes",
                   body, "application/json") == 409:
            # Already published — quite possibly by an earlier run that left it
            # without bounds and therefore unusable. Write it over rather than
            # leave a layer that is listed and cannot be read.
            gs.call("PUT",
                    f"/rest/workspaces/{WORKSPACE}/datastores/{name}"
                    f"/featuretypes/{layer}", body, "application/json")


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

    ensure_store(gs, cfg, host, STORE, "public", LAYERS, on_step)
    ensure_store(gs, cfg, host, OVERVIEW_STORE, "gis", OVERVIEW_LAYERS, on_step)

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

    # Ask it back rather than trusting that the calls meant what they said: a
    # store whose database credentials are wrong is accepted happily and then
    # publishes nothing, and "Done" would be a lie.
    on_step("  checking what it now publishes")
    from . import geoserver as gsread

    try:
        published = [f["name"] for f in gsread.feature_types(gs.base, {"Authorization": gs.auth})]
    except SystemExit as err:
        raise SystemExit(
            f"{err}\n\n"
            "  The objects were created but the server lists no layers, which\n"
            "  almost always means the database store cannot connect. Check in\n"
            "  GeoServer under Data > Stores > splatworld_pg that host, port,\n"
            "  database and the 'geoserver' password are right for this machine."
        ) from err
    missing = [name for name in LAYERS + OVERVIEW_LAYERS
               if f"{WORKSPACE}:{name}" not in published and name not in published]
    if missing:
        on_step(f"  warning: not published yet: {', '.join(missing)}")
    else:
        on_step(f"  confirmed: {len(published)} layer(s) published")

    # Listed is not the same as usable: a layer with no bounds, or one whose
    # store cannot reach the database, appears in the capabilities and then
    # fails the moment QGIS asks it for anything. So ask it for something.
    on_step("  checking a layer can actually be read")
    probe = (f"{gs.base}/{WORKSPACE}/wfs?service=WFS&version=2.0.0"
             f"&request=GetFeature&typeNames={WORKSPACE}:area&count=1")
    answer = fetch(probe, {"Authorization": gs.auth}, what="reading area")
    if b"ExceptionReport" in answer or b"ServiceException" in answer:
        raise SystemExit(
            "geoserver: the layers are published but cannot be read.\n"
            f"  {answer[:400].decode('utf8', 'replace')}\n"
            "  This is usually the store: check in GeoServer under Data > Stores\n"
            "  > splatworld_pg that host, port, database, schema (gis) and the\n"
            "  geoserver password are right for this machine."
        )
    on_step("  read one back")

    # Readable is still not the same as drawable, and "read-only" is exactly
    # what every earlier attempt got wrong. So ask for a write: an Update whose
    # filter matches no row changes nothing, but GeoServer decides whether the
    # layer may be written before it looks at the filter, and says so.
    on_step("  checking a layer can actually be written")
    answer = gs.post_raw(f"/{WORKSPACE}/wfs", WRITE_PROBE)
    text = answer.decode("utf8", "replace")
    if "TransactionResponse" not in text:
        raise SystemExit(
            "geoserver: the layers are published but QGIS could not save into them.\n"
            f"  {text[:400]}\n"
            "  Check in GeoServer under Data > Stores > splatworld_pg that the\n"
            "  schema is 'public' and that Services > WFS is at service level\n"
            "  Complete."
        )
    on_step("  wrote nothing, successfully — QGIS can draw on these")
    return f"{gs.base}/{WORKSPACE}/wfs"


# An Update on `area` with a filter no row can match: proves the layer accepts
# transactions without touching the world.
WRITE_PROBE = (
    b'<wfs:Transaction service="WFS" version="2.0.0"'
    b' xmlns:wfs="http://www.opengis.net/wfs/2.0"'
    b' xmlns:fes="http://www.opengis.net/fes/2.0"'
    b' xmlns:sw="http://splatworld">'
    b'<wfs:Update typeName="sw:area">'
    b'<wfs:Property><wfs:ValueReference>detail</wfs:ValueReference>'
    b'<wfs:Value>14</wfs:Value></wfs:Property>'
    b'<fes:Filter><fes:ResourceId rid="area.00000000-0000-0000-0000-000000000000"/>'
    b'</fes:Filter></wfs:Update></wfs:Transaction>'
)


def write_qgis_connection(target: Path, wfs_url: str) -> Path:
    """A file QGIS loads instead of being told the address by hand."""
    target.write_text(
        '<!DOCTYPE connections>\n<qgsWFSConnections version="1.0">\n'
        f'  <wfs name="splatworld" url="{wfs_url}" version="auto"\n'
        '       ignoreAxisOrientation="0" invertAxisOrientation="0"\n'
        '       pagingEnabled="true" preferCoordinatesForWfsT11="false"/>\n'
        '</qgsWFSConnections>\n', encoding="utf8")
    return target
