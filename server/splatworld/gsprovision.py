"""Sets your GeoServer up as the drawing surface for the world.

This is infra/geoserver/provision.sh without the bash, so it runs on Windows.
It talks to GeoServer's REST API and makes it publish the editable layers that
live in this world's database:

    area  instance                        (editable views, schema gis)
    f_<kind>                              (one per kind people draw, generated
                                           from the world's vocabulary)
    tile                                  (read-only overview of compile state)

Views with only the columns a drawer touches (db/0031): GeoServer sends every
published column and fills a blank with a placeholder rather than NULL, and
publishing a subset of a table's columns makes the layer read-only. A view has
no primary key of its own, so the store is told where gis.gt_pk_metadata
records them — and the setup ends with a real write, because that setting
being ignored is exactly what "area is read-only" looks like.

Then QGIS edits them over WFS-T and a database trigger marks the covering tiles
dirty, which is the work queue. GeoServer is admin and visualisation only and
is never the app API (Invariant 9); the browser talks to PostgREST.

Idempotent — objects that already exist come back 401/409 and are left alone.
"""
from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

from . import crs
from .config import Config
from .importer import absolute_url, fetch

WORKSPACE = "splatworld"
STORE = "splatworld_pg"
SCHEMA = "gis"
# The layers every world has whatever its vocabulary is. The drawable ones are
# generated from `kind` (db/0041_gisforms.sql) and asked for at publish time, so
# a kind an admin invented this morning is a QGIS layer this afternoon.
FIXED_LAYERS = ("area", "instance", "tile")
STYLES = ("tile", "area")


def drawable_layers(cfg: Config | None) -> tuple[str, ...]:
    """One layer per kind people draw, straight from the world's vocabulary.

    Generated views (db/0041_gisforms.sql), so publishing asks the world what it
    holds instead of carrying a list that goes stale the moment an admin adds a
    kind. A database that cannot be reached publishes the fixed layers only,
    which is what an operator setting GeoServer up before the world exists gets.
    """
    if cfg is None:
        return ()
    import psycopg

    try:
        with psycopg.connect(cfg.dsn(), autocommit=True, connect_timeout=5) as conn:
            rows = conn.execute("SELECT gis_layers()").fetchone()[0]
    except Exception:  # noqa: BLE001 - the store check below says it properly
        return ()
    return tuple(row["layer"] for row in rows)


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
             content_type: str = "application/xml", tolerate: tuple[int, ...] = ()) -> int:
        request = urllib.request.Request(
            f"{self.base}{path}", data=body, method=method,
            headers={"Authorization": self.auth, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=60) as res:
                return res.status
        except urllib.error.HTTPError as err:
            detail = err.read()[:300].decode("utf8", "replace")
            if err.code in tolerate:
                return err.code
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

    Declared and native are both the world SRS (crs.WORLD), FORCE_DECLARED:
    GeoServer serves what Postgres stores and never guesses a native SRS off a
    view. Publishing in the tile projection to dodge the axis-order argument
    was tried, and GeoServer stored the Mercator numbers raw:
    REPROJECT_TO_DECLARED reprojects what it serves, not what it is sent.
    """
    whole_earth = {"minx": -180.0, "maxx": 180.0, "miny": -90.0, "maxy": 90.0,
                   "crs": crs.WORLD}
    body = {
        "name": layer,
        "nativeName": layer,
        "srs": crs.WORLD,
        "nativeCRS": crs.WORLD,
        "nativeBoundingBox": whole_earth,
        "latLonBoundingBox": whole_earth,
        "projectionPolicy": "FORCE_DECLARED",
        "enabled": True,
    }
    return json.dumps({"featureType": body}).encode()


PK_TABLE = "gis.gt_pk_metadata"


def store_body(cfg: Config, db_host: str, db_password: str) -> bytes:
    """GeoServer connection keys contain spaces, so this goes as JSON."""
    entries = {
        "host": db_host, "port": str(cfg.pg_port), "database": cfg.pg_database,
        "user": "geoserver", "passwd": db_password, "dbtype": "postgis",
        "schema": SCHEMA, "Expose primary keys": "false",
        "validate connections": "true",
        # Everything drawable is a view, and a view has no primary key of its
        # own; without this GeoTools finds none and serves the layer read-only.
        "Primary key metadata table": PK_TABLE,
    }
    return json.dumps({"dataStore": {"name": STORE, "connectionParameters": {
        "entry": [{"@key": k, "$": v} for k, v in entries.items()]}}}).encode()


def check_store(gs: GeoServer, on_step=print) -> None:
    """Confirm the settings that decide whether QGIS may draw actually landed."""
    store = gs.read(f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}.json")
    entries = store.get("dataStore", {}).get("connectionParameters", {}).get("entry", [])
    held = {e.get("@key"): e.get("$") for e in entries if isinstance(e, dict)}
    wrong = [(k, want, held.get(k)) for k, want in
             (("schema", SCHEMA), ("Primary key metadata table", PK_TABLE))
             if held.get(k) != want]
    if wrong:
        raise SystemExit(
            "geoserver: the store was written but did not keep its settings:\n"
            + "".join(f"  {k} should be {want!r} and is {got!r}\n" for k, want, got in wrong)
            + f"  Delete it under Data > Stores > {STORE} and press 'Set it up' again."
        )
    on_step(f"    settings confirmed: schema {SCHEMA}, primary keys from {PK_TABLE}")


def ensure_store(gs: GeoServer, cfg: Config, host: str, on_step) -> None:
    on_step(f"  store {STORE}: {host}:{cfg.pg_port}/{cfg.pg_database}, schema {SCHEMA}")
    body = store_body(cfg, host, cfg.geoserver_password)
    if gs.call("POST", f"/rest/workspaces/{WORKSPACE}/datastores",
               body, "application/json") == 409:
        # A store of that name already exists — but "exists" says nothing about
        # whether it points anywhere useful. One left over from an earlier
        # attempt, aimed at the wrong schema or host, publishes layers that
        # cannot be read, so its settings are written rather than trusted.
        on_step("    it was already there; writing the settings over it")
        gs.call("PUT", f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}",
                body, "application/json")

    # GeoServer keeps live connection pools keyed by the store, and a store it
    # already has open is not necessarily reopened when its settings change. A
    # reset drops them, so what was just written is what the next request uses.
    gs.call("POST", "/rest/reset")
    check_store(gs, on_step)

    # What this world holds, asked of this world: the drawable layers are
    # generated from `kind`, so publishing reads them rather than knowing them.
    layers = FIXED_LAYERS + drawable_layers(cfg)

    # Layers an earlier layout published and this one does not: a layer whose
    # view is gone makes GeoServer fail every transaction in the workspace
    # with "Schema 'feature' does not exist", not only requests for that layer.
    listed = gs.read(f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}/featuretypes.json?list=configured")
    names = [ft["name"] for ft in (listed.get("featureTypes") or {}).get("featureType", [])
             if isinstance(ft, dict)]
    for stale in [n for n in names if n not in layers]:
        on_step(f"  removing layer {stale}, which this world no longer has")
        gs.call("DELETE", f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}"
                          f"/featuretypes/{stale}?recurse=true", tolerate=(404,))

    for layer in layers:
        on_step(f"  layer {layer}")
        body = featuretype_body(layer)
        if gs.call("POST",
                   f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}/featuretypes",
                   body, "application/json") == 409:
            # Already published — by an earlier run, possibly from a store that
            # no longer exists, possibly without bounds, possibly with a column
            # list that made it read-only. Whatever holds it is removed and it
            # is published afresh; the styles are put back right after this.
            on_step("    it was already there; publishing it again")
            for store in (STORE, "splatworld_gis"):
                gs.call("DELETE",
                        f"/rest/workspaces/{WORKSPACE}/datastores/{store}"
                        f"/featuretypes/{layer}?recurse=true", tolerate=(404,))
            gs.call("POST",
                    f"/rest/workspaces/{WORKSPACE}/datastores/{STORE}/featuretypes",
                    body, "application/json")


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

    ensure_store(gs, cfg, host, on_step)

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
    layers = FIXED_LAYERS + drawable_layers(cfg)
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
    missing = [name for name in layers
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
        # The words, not the envelope: the reason sits in ExceptionText, and
        # the XML around it is long enough to push it out of view.
        said = re.findall(r"<ows:ExceptionText>(.*?)</ows:ExceptionText>", text, re.S)
        reason = "\n  ".join(t.strip() for t in said) if said else text[:3000]
        raise SystemExit(
            "geoserver: the layers are published but QGIS could not save into them.\n"
            f"  {reason}\n"
            f"  Check in GeoServer under Data > Stores > {STORE} that the schema\n"
            f"  is '{SCHEMA}', 'Primary key metadata table' is '{PK_TABLE}', and\n"
            "  that Services > WFS is at service level Complete."
        )
    on_step("  wrote nothing, successfully — GeoServer accepts writes")

    # GeoServer accepting a write is still not the database accepting the row,
    # and when the database refuses one, GeoServer reports "Error inserting
    # features" and drops the reason. So do here exactly what a Save in QGIS
    # does — every column sent, blanks as NULL, as the geoserver role — inside
    # a transaction that is rolled back, and show the database's own words.
    on_step("  checking the database takes a row the way QGIS sends it")
    check_drawing(cfg, on_step)
    return f"{gs.base}/{WORKSPACE}/wfs"


def check_drawing(cfg: Config, on_step=print) -> None:
    import psycopg

    dsn = (f"host={cfg.pg_host} port={cfg.pg_port} user=geoserver "
           f"password={cfg.geoserver_password} dbname={cfg.pg_database}")
    # Exactly the statements GeoServer builds for a Save with the fields left
    # blank: every column of the view, a blank number as 0, the id fetched back.
    probe = (
        ("an area", "INSERT INTO gis.area (geom, detail)"
                    " VALUES (st_geomfromtext('POLYGON((0 0, 0.001 0,"
                    " 0.001 0.001, 0 0.001, 0 0))', world_srid()), 0) RETURNING id"),
        ("a road", "INSERT INTO gis.f_road (geom)"
                   " VALUES (st_geomfromtext("
                   "'LINESTRING(0.0002 0.0002, 0.0004 0.0004)', world_srid())) RETURNING id"),
    )
    try:
        with psycopg.connect(dsn, connect_timeout=5) as conn:
            for what, sql in probe:
                try:
                    conn.execute(sql)
                except psycopg.Error as err:
                    raise SystemExit(
                        f"geoserver: GeoServer is fine, but the database refuses {what}\n"
                        f"  drawn from QGIS. Postgres says:\n"
                        f"    {(err.diag.message_primary or str(err)).strip()}\n"
                        + ("  Create your account in Setup, step 1 — it owns what you draw.\n"
                           if "account" in str(err) else "")
                        + "  The migration that fixes this may not be applied: stop the\n"
                          "  server and run `splatworld run` again — it applies what is new."
                    ) from err
            conn.rollback()
    except psycopg.OperationalError as err:
        raise SystemExit(
            f"geoserver: could not connect to the database as 'geoserver' — {err}\n"
            "  That is the login GeoServer uses. Its password is GEOSERVER_DB_PASSWORD\n"
            "  in .env and must match what db/0008 set."
        ) from err
    on_step("  it does — QGIS can draw on these")


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
    """A file QGIS loads instead of being told the address by hand.

    WFS 1.0.0 on purpose. From 1.1 on, the world SRS means latitude first, and
    which side is supposed to swap is a decade-old argument between clients
    and servers; the first Save from QGIS came back as "-100.9 outside of
    (-90, 90)" — a longitude read as a latitude. 1.0.0 is longitude first,
    always, on both ends, and GeoServer speaks WFS-T in it.
    """
    target.write_text(
        '<!DOCTYPE connections>\n<qgsWFSConnections version="1.0">\n'
        f'  <wfs name="splatworld" url="{wfs_url}" version="1.0.0"\n'
        '       ignoreAxisOrientation="0" invertAxisOrientation="0"\n'
        '       pagingEnabled="false" preferCoordinatesForWfsT11="false"/>\n'
        '</qgsWFSConnections>\n', encoding="utf8")
    return target
