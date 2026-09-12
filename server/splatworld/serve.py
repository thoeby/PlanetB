"""The file store and the static client, on one port.

This is what infra/nginx.conf does, in Python, so a machine without an nginx
built --with-http_dav_module can still run a world. It serves bytes and asks the
database whether a PUT is allowed; it decides nothing itself and computes
nothing about the world (Invariant 9).

Routes, matching nginx.conf exactly:

    /healthz                     ok
    /app/...                     the client, from client/
    /assets|tiles|jobs|geo/...   GET public and immutable; PUT authorised
"""
from __future__ import annotations

import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from . import ground
from .config import Config

STORE_PREFIXES = ("assets", "tiles", "jobs", "geo")

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".glb": "model/gltf-binary",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Sha256",
    "Access-Control-Max-Age": "86400",
}

MAX_UPLOAD = 512 * 1024 * 1024


# When this process loaded its code. A running server keeps executing what it
# read at start, so `git pull` changes the checkout and nothing else — every
# symptom of that is indistinguishable from the fix not working.
STARTED = time.time()


def newest_source(directory: Path) -> float:
    if not directory.is_dir():
        return 0.0
    return max((f.stat().st_mtime for f in directory.glob("*.py")), default=0.0)


def code_is_stale(cfg: Config) -> str | None:
    """Say so when the code that is running is not the code in the checkout.

    Two ways to end up running yesterday's fix, and both look exactly like the
    fix not working: the server was started before the pull, or the package was
    installed as a copy (`pip install ./server` rather than `-e ./server`), so
    the checkout moves and site-packages does not.
    """
    from . import __file__ as package_file

    loaded = Path(package_file).resolve().parent
    checkout = (cfg.repo / "server" / "splatworld").resolve()

    if loaded != checkout and newest_source(checkout) > newest_source(loaded):
        return (f"What is running is the copy in {loaded}, and the code in "
                f"{cfg.repo} is newer. `git pull` does not change a copy. "
                "Install it as a link to the checkout instead, once:\n"
                "    python -m pip install -e ./server\n"
                "then stop this server (Ctrl-C) and run `splatworld run` again.")

    if max(newest_source(loaded), newest_source(checkout)) > STARTED:
        return ("The code on disk has changed since this server started, so "
                "what is running here is the old code. Stop it in the terminal "
                "(Ctrl-C) and run `splatworld run` again, then try this again.")
    return None


def content_type(path: Path) -> str:
    return TYPES.get(path.suffix.lower(), "application/octet-stream")


def point_at_this_server(html: bytes, cfg: Config) -> bytes:
    """Rewrites the client's endpoint tags to wherever this server actually is.

    client/*.html carry `<meta name="splatworld:api|files">` pointing at
    localhost:3000 and :8080. Those are only right when nothing forced a
    different port — and Windows does force one: 8080 often falls inside a
    reserved range and cannot be bound at all. The page is served by the very
    server it has to talk to, so it is told the truth on the way out rather
    than being edited by hand.
    """
    host = "127.0.0.1" if cfg.host in ("0.0.0.0", "::", "") else cfg.host
    for key, value in (("api", cfg.api_url), ("files", f"http://{host}:{cfg.port}")):
        html = re.sub(
            (rf'(<meta\s+name=["\']splatworld:{key}["\']\s+content=["\'])'
             r'[^"\']*(["\'])').encode(),
            lambda m, v=value: m.group(1) + v.encode() + m.group(2),
            html, flags=re.IGNORECASE)
    return html


def safe_join(root: Path, relative: str) -> Path | None:
    """None for anything that would leave root — .., absolute paths, symlinks."""
    candidate = (root / relative.lstrip("/")).resolve()
    root = root.resolve()
    return candidate if candidate == root or root in candidate.parents else None


def can_write(cfg: Config, path: str, sha256: str, length: int,
              auth: str | None) -> tuple[int, str]:
    """Asks PostgREST, exactly as nginx's auth_request does.

    The database decides every write (Invariant 6); this only relays the answer,
    including its status: can_write raises PT401 for "no token" and PT403 for
    "not yours", and PostgREST turns those into 401 and 403. A caller that is
    merely signed out must be told so, not told it is forbidden.
    """
    query = urllib.parse.urlencode({"path": path, "sha256": sha256, "bytes": length})
    req = urllib.request.Request(f"{cfg.api_url}/rpc/can_write?{query}", method="GET")
    req.add_header("Accept", "application/json")
    if auth:
        req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return (200 if 200 <= res.status < 300 else 403), ""
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf8", "replace")[:400]
        try:
            body = json.loads(body).get("message", body)
        except ValueError:
            pass
        # Anything that is not a decision (a 500, a broken API) is not a licence
        # to write, so it becomes a refusal rather than an error to the client.
        return (err.code if err.code in (401, 403) else 403), body
    except OSError as err:
        return 403, f"the API is not answering ({err})"


class Handler(BaseHTTPRequestHandler):
    server_version = "splatworld"
    protocol_version = "HTTP/1.1"

    cfg: Config  # set on the server class below

    # -------------------------------------------------------------- plumbing

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib name
        if self.server.verbose:
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8",
              extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _text(self, status: int, message: str) -> None:
        self._send(status, f"{message}\n".encode("utf8"), extra=CORS)

    def _route(self) -> tuple[str, str]:
        path = urllib.parse.urlparse(self.path).path
        first = path.lstrip("/").split("/", 1)[0]
        return path, first

    # ------------------------------------------------------------- responses

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib name
        self._send(204, extra=CORS)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        path, first = self._route()
        if path == "/healthz":
            self._send(200, b"ok\n")
        elif path == "/" or path == "/app" or path.startswith("/app/"):
            self._serve_client(path)
        elif first in STORE_PREFIXES:
            self._serve_store(path)
        else:
            self._text(404, "not found")

    def _serve_client(self, path: str) -> None:
        rel = path[len("/app"):] if path.startswith("/app") else "/"
        if rel in ("", "/"):
            rel = "/play.html"
        target = safe_join(self.cfg.client_dir, rel)
        if target and target.is_dir():
            target = target / "play.html"
        if not target or not target.is_file():
            self._text(404, "no such page")
            return
        body = target.read_bytes()
        if target.suffix.lower() == ".html":
            body = point_at_this_server(body, self.cfg)
        # The client is edited while the server runs; never let a browser cache it.
        self._send(200, body, content_type(target), {"Cache-Control": "no-store"})

    def _serve_store(self, path: str) -> None:
        target = safe_join(self.cfg.files, path)
        # T1: the ground is cut when somebody first walks onto it, not seeded
        # ahead of time. Outside the coverage there is no world, and 404 is the
        # honest answer — client/lib/geo.js reads it as "no ground here".
        if target and not target.is_file():
            tile = ground.parse_request(path)
            if tile:
                try:
                    target = ground.cut(self.cfg, *tile) or target
                except (Exception, SystemExit) as err:  # noqa: BLE001
                    # 404 here would be read as "there is no world at this
                    # tile" (client/lib/geo.js), and the tab would say the
                    # ground is outside the coverage when what actually
                    # happened is that the cut failed. Say which.
                    self.log_message("could not cut %s: %s", path, err)
                    self._text(502, f"could not cut the ground for {path}: {err}")
                    return
        if not target or not target.is_file():
            self._text(404, "no such file")
            return
        # Invariant 1: a path holds one artifact for ever, so it can be cached
        # for ever.
        headers = {"Cache-Control": "public, max-age=31536000, immutable", **CORS}
        self.send_response(200)
        self.send_header("Content-Type", content_type(target))
        self.send_header("Content-Length", str(target.stat().st_size))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            with target.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile)

    # ----------------------------------------------------------- the importer

    def _from_this_machine(self) -> bool:
        """The import endpoints write to the world with the owner's authority.

        They are therefore offered only to a browser on this very machine, even
        when the server is bound to 0.0.0.0 so other people can look at the
        world. Nothing here is reachable from the network.
        """
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > (8 << 20):
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return {}

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf8"),
                   "application/json; charset=utf-8", CORS)

    def do_POST(self) -> None:  # noqa: N802
        path, _ = self._route()
        # Read the body first, always, whether or not the route wants it. This
        # is a keep-alive connection, and bytes left unread are parsed as the
        # beginning of the next request — which then arrives as a method named
        # "{}POST" and takes the rest of the conversation down with it.
        body = self._read_json()
        # These are answered to a page that does JSON.parse on everything it
        # gets back, so even the refusals are JSON. A plain-text 404 here
        # surfaces in the browser as "unexpected keyword at line 1 column 1",
        # which tells nobody anything.
        if not path.startswith(("/import/", "/setup/")):
            self._json(404, {"ok": False, "error": f"no such thing as {path}"})
            return
        if not self._from_this_machine():
            self._json(403, {"ok": False,
                             "error": "this page only works on this machine"})
            return
        if path == "/setup/state":
            self._setup_state()
            return

        # The rest do real work with the code this process loaded at start, so
        # a checkout that has moved on since then must not quietly pretend to
        # be the fix that was just pulled.
        stale = code_is_stale(self.cfg)
        if stale:
            self._json(200, {"ok": False, "log": [], "error": stale})
            return

        if path == "/setup/geoserver":
            self._setup_geoserver(body)
        elif path == "/setup/probe":
            # What that GeoServer publishes, for the Setup panel to offer as the
            # ground (T0). The import page that used to ask this is gone.
            self._probe(body)
        elif path == "/setup/account":
            self._setup_account(body)
        elif path == "/setup/lastfail":
            self._last_db_errors()
        elif path == "/setup/clear":
            self._clear_drawn()
        elif path == "/import/properties":
            self._import_properties()
        elif path == "/import/probe":
            self._probe(body)
        elif path == "/import/run":
            self._import(body)
        else:
            self._json(404, {"ok": False, "error": f"no such thing as {path}"})

    # ---------------------------------------------------------------- setup

    def _setup_state(self) -> None:
        """What is already configured, so the page opens filled in."""
        from . import config as configmod

        saved = configmod.load_dotenv(self.cfg.repo / ".env")
        drawn = 0
        try:
            import psycopg
            with psycopg.connect(self.cfg.dsn(), connect_timeout=5) as conn:
                drawn = conn.execute("SELECT count(*) FROM area").fetchone()[0]
        except Exception:  # noqa: BLE001 - the page copes with not knowing
            pass
        self._json(200, {
            "account": saved.get("SPLATWORLD_ACCOUNT", ""),
            "areas": drawn,
            "geoserver_url": saved.get("GEOSERVER_URL", ""),
            "geoserver_user": saved.get("GEOSERVER_ADMIN_USER", "admin"),
            # Whether one is stored, never the value itself.
            "geoserver_password_saved": bool(saved.get("GEOSERVER_ADMIN_PASSWORD")),
            "repo": str(self.cfg.repo),
            "version": __version__,
        })

    def _setup_account(self, body: dict) -> None:
        """The account you sign in with, and the one QGIS draws as."""
        from . import config as configmod
        from . import importer

        email = (body.get("email") or "").strip()
        password = body.get("password") or ""
        if not email or not password:
            self._json(400, {"error": "An email and a password, please."})
            return
        try:
            importer.ensure_account(self.cfg, email, password)
        except Exception as err:  # noqa: BLE001
            self._json(200, {"ok": False, "error": f"{type(err).__name__}: {err}"})
            return
        configmod.save(self.cfg, {"SPLATWORLD_ACCOUNT": email})
        self._json(200, {"ok": True, "log": [f"  account {email} is ready"]})

    def _clear_drawn(self) -> None:
        """Everything drawn, gone — for a world that is being set up.

        A polygon saved in the wrong place (an axis-order mishap puts one off
        Somalia; a reprojection one puts it at longitude 877197) is hard to
        even select in QGIS. This is the one place it can be undone without
        typing SQL. Accounts, elevation and the catalogue are untouched.
        """
        import psycopg

        try:
            with psycopg.connect(self.cfg.dsn(), connect_timeout=5) as conn:
                gone = {t: conn.execute(f"DELETE FROM {t}").rowcount
                        for t in ("instance", "feature", "area")}
                conn.commit()
        except psycopg.Error as err:
            self._json(200, {"ok": False, "error": f"could not clear: {err}"})
            return
        self._json(200, {"ok": True, "log": [
            f"  removed {gone['area']} area(s), {gone['feature']} feature(s), "
            f"{gone['instance']} instance(s)"]})

    def _last_db_errors(self) -> None:
        """What Postgres refused lately, in its own words.

        A Save in QGIS that the database rejects reaches QGIS as "Error
        inserting features" — GeoServer keeps the reason. Postgres writes it
        to its log, and the server is on the same machine as the database, so
        it can be read from here rather than found in a folder.
        """
        import psycopg

        try:
            with psycopg.connect(self.cfg.dsn(), autocommit=True, connect_timeout=5) as conn:
                logfile = conn.execute("SELECT pg_current_logfile()").fetchone()[0]
                if not logfile:
                    self._json(200, {"ok": False, "error":
                               "Postgres is not writing a log file (logging_collector is off),"
                               " so the reason is not recorded anywhere I can read."})
                    return
                size = conn.execute("SELECT size FROM pg_stat_file(%s)", (logfile,)).fetchone()[0]
                start = max(size - 200_000, 0)
                tail = conn.execute("SELECT pg_read_file(%s, %s, %s)",
                                    (logfile, start, size - start)).fetchone()[0]
        except psycopg.Error as err:
            self._json(200, {"ok": False, "error": f"could not read the log: {err}"})
            return
        keep = [line for line in tail.splitlines()
                if any(tag in line for tag in ("ERROR:", "DETAIL:", "STATEMENT:",
                                               "CONTEXT:", "HINT:"))]
        self._json(200, {"ok": True, "log": keep[-40:] or
                         ["nothing refused in the last part of the log"],
                         "file": logfile})

    def _setup_geoserver(self, body: dict) -> None:
        """Test, or set up, the GeoServer — and remember what worked.

        One button's worth of work: the page never has to know that setting up
        is several REST calls, and nothing is typed a second time.
        """
        from . import config as configmod
        from . import gsprovision

        url = (body.get("url") or "").strip()
        if not url:
            self._json(400, {"error": "Type your GeoServer address first."})
            return
        saved = configmod.load_dotenv(self.cfg.repo / ".env")
        user = (body.get("user") or "admin").strip()
        password = body.get("password") or saved.get("GEOSERVER_ADMIN_PASSWORD", "")

        # First line of every run: which file this is and what version, so the
        # log itself answers "is this even the code you pulled" and nobody has
        # to be asked to run anything to find out.
        from . import gsprovision as _module

        log: list[str] = [f"  running {_module.__file__} (version {__version__})"]
        try:
            if body.get("provision"):
                wfs = gsprovision.provision(self.cfg, url, user, password,
                                            on_step=log.append)
                gsprovision.write_qgis_connection(
                    self.cfg.repo / "gis" / "splatworld-wfs.xml", wfs)
            else:
                gs = gsprovision.GeoServer(url, user, password)
                # /rest/about/version is the smallest thing that proves both
                # "this is a GeoServer" and "these credentials work".
                gs.call("GET", "/rest/about/version.json")
                log.append(f"  reached {gs.base} and the login was accepted")
                wfs = f"{gs.base}/{gsprovision.WORKSPACE}/wfs"
        except SystemExit as err:
            self._json(200, {"ok": False, "log": log, "error": str(err)})
            return
        except Exception as err:  # noqa: BLE001
            self._json(200, {"ok": False, "log": log,
                             "error": f"{type(err).__name__}: {err}"})
            return

        configmod.save(self.cfg, {
            "GEOSERVER_URL": url,
            "GEOSERVER_ADMIN_USER": user,
            **({"GEOSERVER_ADMIN_PASSWORD": password} if password else {}),
        })
        log.append("  saved, so it does not have to be typed again")
        self._json(200, {"ok": True, "log": log, "wfs": wfs})

    def _probe(self, body: dict) -> None:
        """What a GeoServer — or this database — has, as a list to pick from."""
        from . import geoserver

        if (body.get("source") or "").strip() == "postgis":
            self._probe_postgis(body)
            return

        url = (body.get("url") or "").strip()
        if not url:
            self._json(400, {"error": "type your GeoServer address first"})
            return
        # The wording comes from the importer, which says "import:" because that
        # is where it is usually read. This is the Setup panel.
        plain = lambda text: str(text).replace("import: ", "", 1)  # noqa: E731
        try:
            found = geoserver.probe(url, body.get("user"), body.get("password"))
            if found.get("error"):
                found["error"] = plain(found["error"])
            self._json(200, found)
        except SystemExit as err:
            self._json(200, {"error": plain(err)})
        except Exception as err:  # noqa: BLE001 - the page shows whatever broke
            self._json(200, {"error": f"{type(err).__name__}: {err}"})

    def _import_properties(self) -> None:
        """Which feature properties the world's rules actually read.

        The import page offers these as the things a column can be mapped to.
        They are not a list in the page and not a constant in the compiler:
        they are whatever `build_rule` mentions (db/0036_rules.sql), so adding
        a rule that reads `bhd` makes `bhd` mappable with nothing to change.
        """
        import psycopg

        query = """
            SELECT r.kind, array_agg(DISTINCT p) FROM build_rule r,
            LATERAL (
              SELECT jsonb_path_query(jsonb_build_array(r.filter, r.style),
                                      '$.**.prop') #>> '{}' AS p
              UNION
              SELECT v #>> '{}' FROM jsonb_each(r.style) e(k, v)
              WHERE e.k LIKE %s
            ) q
            WHERE p IS NOT NULL AND r.enabled GROUP BY r.kind
        """
        try:
            with psycopg.connect(self.cfg.dsn(), autocommit=True,
                                 connect_timeout=10) as conn:
                rows = conn.execute(query, ("%\_prop",)).fetchall()
            self._json(200, {"properties": {kind: sorted(props) for kind, props in rows}})
        except Exception as err:  # noqa: BLE001 - the page falls back to typing
            self._json(200, {"properties": {}, "error": f"{type(err).__name__}: {err}"})

    def _probe_postgis(self, body: dict) -> None:
        """The spatial tables of a database, offered exactly like WFS layers."""
        from . import postgis

        try:
            found = postgis.layers(self.cfg, body)
            self._json(200, {"layers": found, "coverages": [],
                             "coverages_error": "a database holds no rasters "
                             "the importer can read — give a GeoTIFF or a "
                             "GeoServer coverage for elevation"})
        except SystemExit as err:
            self._json(200, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 - the page shows whatever broke
            self._json(200, {"error": f"{type(err).__name__}: {err}"})

    def _import(self, body: dict) -> None:
        from . import importer

        lines: list[str] = []
        try:
            importer.run_spec(self.cfg, body, Path.cwd(), out=lambda m: lines.append(str(m)))
            self._json(200, {"ok": True, "log": lines})
        except SystemExit as err:
            self._json(200, {"ok": False, "log": lines, "error": str(err)})
        except Exception as err:  # noqa: BLE001
            self._json(200, {"ok": False, "log": lines,
                             "error": f"{type(err).__name__}: {err}"})

    def do_PUT(self) -> None:  # noqa: N802
        path, first = self._route()
        if first not in STORE_PREFIXES:
            self._text(405, "nothing is writable here")
            return
        target = safe_join(self.cfg.files, path)
        if not target:
            self._text(400, "bad path")
            return
        # Invariant 1: a path is written once. Overwriting is a conflict, not an
        # update, and needs nobody's opinion.
        if target.exists():
            self._text(409, "already written")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._text(411, "length required")
            return
        if length > MAX_UPLOAD:
            self._text(413, "too large")
            return

        status, why = can_write(
            self.cfg, path, self.headers.get("X-Sha256", ""), length,
            self.headers.get("Authorization"),
        )
        if status != 200:
            self._text(status, why or "refused")
            return

        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + ".part")
        try:
            with partial.open("wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise OSError("upload ended early")
                    fh.write(chunk)
                    remaining -= len(chunk)
            # Renamed only once whole, so a dropped connection never leaves a
            # short file at a path that may never be written again.
            partial.replace(target)
        except OSError as err:
            partial.unlink(missing_ok=True)
            self._text(500, f"could not store it: {err}")
            return
        self._text(201, "created")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, cfg: Config, *, verbose: bool = False):
        self.verbose = verbose
        handler = type("BoundHandler", (Handler,), {"cfg": cfg})
        super().__init__((cfg.host, cfg.port), handler)


# Windows reserves blocks of ports for Hyper-V and WSL and refuses to bind them
# (WinError 10013), and 8080 is very often inside one. Rather than fail, move up
# until something is free: the pages are told which port they landed on, so a
# different number costs the reader nothing.
PORT_ATTEMPTS = 20


def already_running(host: str, port: int) -> bool:
    """Whether the thing holding that port is another splatworld."""
    where = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    try:
        with urllib.request.urlopen(
                f"http://{where}:{port}/app/version.txt", timeout=2) as res:
            return res.status == 200
    except Exception:  # noqa: BLE001 - anything else is not one of ours
        return False


def listen(cfg: Config, *, verbose: bool = False) -> Server:
    first = cfg.port
    for offset in range(PORT_ATTEMPTS):
        cfg.port = first + offset
        try:
            server = Server(cfg, verbose=verbose)
        except OSError as err:
            if offset == 0 and already_running(cfg.host, cfg.port):
                # Quietly moving to the next port leaves the old process
                # serving the browser tab that is already open, so every fix
                # appears to do nothing while the old code answers the buttons.
                raise SystemExit(
                    f"splatworld: another splatworld is already running on "
                    f"port {cfg.port}.\n"
                    "  That one is what your browser is talking to, and it is\n"
                    "  running the code it was started with. Close it (Ctrl-C in\n"
                    "  its window, or end the python process) and start this one\n"
                    "  again. To run a second world alongside it on purpose:\n"
                    f"    splatworld run --port {cfg.port + 1}"
                ) from err
            if offset == 0:
                print(f"  port {cfg.port} is not available ({err.strerror or err}); "
                      "looking for a free one")
            continue
        if cfg.port != first:
            print(f"  using port {cfg.port} instead of {first}")
        return server
    cfg.port = first
    raise SystemExit(
        f"splatworld: no free port between {first} and {first + PORT_ATTEMPTS - 1}.\n"
        "  Pick one yourself with --port, e.g. `splatworld run --port 9123`.\n"
        "  On Windows, `netsh interface ipv4 show excludedportrange protocol=tcp`\n"
        "  lists the ranges Windows has reserved and will not let anything bind."
    )
