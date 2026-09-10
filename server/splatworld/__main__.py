"""splatworld — run a world on this machine.

    splatworld init     create the database and apply the schema
    splatworld run      start the API and the file store, and open the browser
    splatworld doctor   say what is and is not ready, and why

The same command runs a laptop and a server: `--host 0.0.0.0` is the only
difference, plus a real JWT_SECRET and real passwords in .env.
"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

import psycopg

from . import __version__, config, migrate, serve, services


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", help="address to listen on (default 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port for the client and files")
    parser.add_argument("--api-port", type=int, dest="api_port", help="port for PostgREST")
    parser.add_argument("--verbose", action="store_true", help="show request and API logs")


def parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="splatworld", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create the database and apply the schema")
    init.add_argument("--reset", action="store_true",
                      help="drop the database first — deletes the whole world")
    _common(init)

    run = sub.add_parser("run", help="start the API and the file store")
    run.add_argument("--no-browser", action="store_true", help="do not open a browser")
    _common(run)

    imp = sub.add_parser("import", help="import your elevation and map layers")
    imp.add_argument("spec", help="a region .json — see docs/import.md")
    _common(imp)

    gs = sub.add_parser("geoserver",
                        help="set your GeoServer up so you can draw the world in QGIS")
    gs.add_argument("url", help="your GeoServer address, e.g. localhost:8081/geoserver")
    gs.add_argument("--user", default="admin", help="GeoServer admin user")
    gs.add_argument("--password", default="geoserver", help="GeoServer admin password")
    gs.add_argument("--db-host", dest="db_host",
                    help="how GeoServer reaches this database, if not localhost")
    _common(gs)

    _common(sub.add_parser("doctor", help="check what is ready"))
    return parser.parse_args(argv)


def _cfg(args: argparse.Namespace) -> config.Config:
    return config.load({
        "host": getattr(args, "host", None),
        "port": getattr(args, "port", None),
        "api_port": getattr(args, "api_port", None),
    })


def cmd_init(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    print(f"database {cfg.pg_database} on {cfg.pg_host}:{cfg.pg_port}")
    version = migrate.check_postgis(cfg)
    print(f"  PostGIS {version} available")
    if args.reset:
        print("  dropping the existing database")
    elif migrate.database_exists(cfg) and migrate.schema_present(cfg):
        print("  already initialised — `splatworld init --reset` starts over "
              "(that deletes the world)")
        return 0
    migrate.create_database(cfg, drop=args.reset)
    count = migrate.apply(cfg)
    print(f"  {count} migrations applied")
    print("Ready. `splatworld run` starts it.")
    return 0


def _preflight(cfg: config.Config) -> list[str]:
    problems = []
    try:
        with psycopg.connect(cfg.dsn("postgres"), autocommit=True, connect_timeout=5):
            pass
    except psycopg.OperationalError as err:
        return [migrate.explain(cfg, err)]
    if not migrate.database_exists(cfg):
        problems.append(f"the database {cfg.pg_database!r} does not exist — run `splatworld init`")
    if not services.find_binary(cfg) and not services.alive(cfg):
        problems.append(services.missing_message(cfg))
    if not cfg.client_dir.is_dir():
        problems.append(f"no client/ at {cfg.client_dir} — set SPLATWORLD_REPO")
    return problems


def cmd_doctor(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    print(f"repo          {cfg.repo}")
    print(f"database      {cfg.dsn().replace(cfg.pg_password, '***')}")
    print(f"files         {cfg.files}")
    print(f"client        {cfg.client_dir}")
    print(f"listen        http://{cfg.host}:{cfg.port}")
    print(f"api           {cfg.api_url}")
    problems = _preflight(cfg)
    if not problems:
        print("\nEverything is ready. `splatworld run`.")
        return 0
    print("\nNot ready:")
    for p in problems:
        print(f"  - {p}")
    return 1


def _has_a_region(cfg: config.Config) -> bool:
    try:
        with psycopg.connect(cfg.dsn(), autocommit=True, connect_timeout=5) as conn:
            return bool(conn.execute("SELECT EXISTS (SELECT 1 FROM area)").fetchone()[0])
    except psycopg.Error:
        return True  # not our problem here; the preflight already reported it


def cmd_run(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    # A database that does not exist yet is not a thing to be told off about:
    # make it. `init` stays for people who want the step, and for --reset.
    if not migrate.database_exists(cfg) or not migrate.schema_present(cfg):
        print("no world here yet — making one")
        migrate.check_postgis(cfg)
        migrate.create_database(cfg)
        print(f"  {migrate.apply(cfg, on_step=lambda _: None)} migrations applied")

    problems = _preflight(cfg)
    if problems:
        for p in problems:
            print(f"splatworld: {p}", file=sys.stderr)
        return 1

    cfg.files.mkdir(parents=True, exist_ok=True)
    with services.PostgREST(cfg, verbose=args.verbose):
        server = serve.listen(cfg, verbose=args.verbose)
        url = f"http://{'127.0.0.1' if cfg.host in ('0.0.0.0', '::') else cfg.host}:{cfg.port}"
        print(f"  files and client on {url}")
        # An empty world has nothing to show and nothing to do; send the first
        # run to the page that fills it instead of to a black screen.
        configured = bool(config.load_dotenv(cfg.repo / ".env").get("GEOSERVER_URL"))
        landing = "play.html" if configured and _has_a_region(cfg) else "setup.html"
        if landing == "setup.html":
            print(f"\n  Nothing is set up yet. Start here:\n  Setup       {url}/app/setup.html")
        print(f"\n  Setup        {url}/app/setup.html")
        print(f"  Play/build   {url}/app/play.html")
        print(f"  Import       {url}/app/import.html")
        print(f"  Edit         {url}/app/edit.html")
        print(f"  Catalog      {url}/app/catalog.html")
        print("\nCtrl-C to stop.")
        if not args.no_browser:
            threading.Timer(0.5, webbrowser.open, [f"{url}/app/{landing}"]).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nstopping")
        finally:
            server.shutdown()
            server.server_close()
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    from pathlib import Path

    from . import importer

    cfg = _cfg(args)
    if not migrate.database_exists(cfg) or not migrate.schema_present(cfg):
        print("splatworld: no world here yet — run `splatworld init` first",
              file=sys.stderr)
        return 1
    spec = Path(args.spec)
    if not spec.is_file():
        print(f"splatworld: no such file {spec}", file=sys.stderr)
        return 1
    print(f"importing {spec}")
    return importer.run(cfg, spec)


def cmd_geoserver(args: argparse.Namespace) -> int:
    from pathlib import Path

    from . import gsprovision

    cfg = _cfg(args)
    if not migrate.database_exists(cfg) or not migrate.schema_present(cfg):
        print("splatworld: no world here yet — run `splatworld init` first",
              file=sys.stderr)
        return 1
    print(f"setting up {args.url}")
    wfs = gsprovision.provision(cfg, args.url, args.user, args.password, args.db_host)

    connection = gsprovision.write_qgis_connection(
        cfg.repo / "gis" / "splatworld-wfs.xml", wfs)
    print(f"\nDone. Your GeoServer now publishes the world's editable layers.\n"
          f"  WFS-T endpoint: {wfs}\n"
          f"  QGIS connection file: {connection}\n\n"
          "In QGIS: Layer > Data Source Manager > WFS / OGC API-Features,\n"
          "press 'Load Connections', pick that file, then Connect. Add the\n"
          "feature_* layers and 'area', draw, and press Save. Then open\n"
          "/app/play.html and turn on background work — what you drew compiles.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse(argv if argv is not None else sys.argv[1:])
    commands = {"init": cmd_init, "run": cmd_run, "doctor": cmd_doctor,
                "import": cmd_import, "geoserver": cmd_geoserver}
    try:
        return commands[args.command](args)
    except psycopg.OperationalError as err:
        # Not being able to reach the database is the ordinary first-run
        # problem, not a bug; say which thing is wrong and how to fix it.
        print(f"splatworld: {migrate.explain(_cfg(args), err)}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
