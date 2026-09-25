# Running a world on your own machine

One command starts everything and opens the browser. The same command runs a
laptop and a real server.

```
python -m pip install -e ./server
splatworld init      # create the database and apply the schema
splatworld run       # start it and open the browser
```

Install it with **`-e`** (editable) if you are following the repository: then
`git pull` is enough and the command picks the changes up. A plain
`pip install ./server` copies the code, so every `git pull` has to be followed
by installing again — which is a very easy thing to forget, and looks exactly
like the fix not working.

## What you have to install

**PostgreSQL with PostGIS.** This is the one thing that cannot come from pip:
no pip-installable PostgreSQL ships PostGIS today, and the schema is PostGIS
from top to bottom.

- **Windows** — the installer from [postgresql.org](https://www.postgresql.org/download/windows/).
  At the end it offers *Stack Builder*; tick **PostGIS** there. Remember the
  password you set for the `postgres` user.
- **Debian/Ubuntu** — `apt install postgresql-16-postgis-3`.
- **macOS** — [Postgres.app](https://postgresapp.com/) has PostGIS built in.

**PostgREST.** One file, no installer. Download the build for your machine from
[its releases](https://github.com/PostgREST/postgrest/releases), put it on your
PATH, or point the `POSTGREST` environment variable at it.

On Windows its build links libpq dynamically and does not ship it: started with
PostgreSQL's `bin` directory (the one with `psql.exe`) off PATH, it dies with
*libpq.dll was not found*. `splatworld run` puts that directory on PATH for it
when it can find it — under `C:\Program Files\PostgreSQL\<version>\bin`, or
wherever `psql` already is. If yours is somewhere else, add it to PATH yourself.

It stays the API: the schema's grants and row-level security are what authorise
every write (Invariant 6), and none of that survives being reimplemented.

Then `python -m pip install -e ./server` from the checkout.

## Settings

`splatworld doctor` prints everything it resolved and what is not ready yet.

Settings come from the environment, or from a `.env` beside the checkout (the
same file the Makefile reads), or from flags — later wins.

| | |
|---|---|
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | the database. Set `PGPASSWORD` to what you chose during install |
| `JWT_SECRET` | signs sign-ins. Anything ≥ 32 characters. **Change it** before anyone else can reach the machine |
| `SPLATWORLD_PORT` | where the client and files are served, default 8081 (8080 is left to the GeoServer or dev server usually already there). If that port is taken — or reserved, which Windows does to whole ranges for Hyper-V and WSL — it moves up until one is free and says so. The pages are told which port they landed on, so nothing needs editing. |
| `SPLATWORLD_HOST` | address to listen on, default 127.0.0.1 |
| `SPLATWORLD_API_PORT` | PostgREST, default 3000 |
| `GEOSERVER_URL` `GEOSERVER_ADMIN_USER` `GEOSERVER_ADMIN_PASSWORD` | the operator's GeoServer, which elevation is cut from. The setup tab writes these into `.env` |
| `AUTHENTICATOR_PASSWORD` | the password of the role PostgREST connects as, default `authenticator` |
| `FILES_ROOT` | where tiles are written, default `infra/files/` |
| `POSTGREST` | path to the binary, if it is not on PATH |
| `SPLATWORLD_REPO` | the checkout, if the package was installed from elsewhere |

## The pages it serves

| | |
|---|---|
| `/app/play.html` | the world, and everything in it: setup, your land, the catalog, the pool, permission, the wallet, sharing, admin |
| `/app/edit.html` | the map editor |
| `/app/view.html` | the read-only viewer |
| `/app/setup.html` `/app/import.html` `/app/catalog.html` `/app/rules.html` | redirects to the world: each of these is a tab of it now |
| `/assets /tiles /jobs /geo` | the file store: public to read, authorised to write. A ground tile under `/geo` that is not there yet is cut from the operator's GeoServer on the first request |
| `/qgis/project.qgs` `/qgis/credentials` `/qgis/save-ground.py` | the QGIS project with the player's own login in it, that login, and the script that saves shaped ground back (`gis/README.md`) |

## Commands

```
splatworld import <file>   import a region from the command line (docs/import.md)
splatworld init            create the database, apply db/*.sql
splatworld init --reset    drop it first — this deletes the whole world
splatworld run             start everything; applies new migrations first
splatworld run --verbose   show request and PostgREST logs
splatworld run --no-browser
splatworld qgis            rewrite gis/splatworld.qgs from the world's vocabulary
splatworld ground z/x/y    ask the GeoServer for one tile's elevation, say what came back
splatworld doctor          what is ready, and what is not
```

## On a server

```
splatworld run --host 0.0.0.0
```

It refuses to start on any address but loopback while `JWT_SECRET` is still
the development one. Then, before anyone else can reach it: a real database
password, and TLS in front — the file store is public to read, and sign-in
tokens go over the same connection. `splatworld` itself listens on 127.0.0.1
unless you say otherwise, which is deliberate.

## Why this exists rather than nginx

The file store needs `PUT` with a permission check. nginx does that with
`ngx_http_dav_module`, which is not in the standard Windows build and means
compiling nginx to get. `server/` is the same contract in Python: it serves
files, asks `rpc/can_write` about every upload, and refuses to overwrite a path
that already exists.

It is held to that claim by `tools/files-test.sh` — the gate written for nginx
— which it passes unmodified, alongside `tools/api-test.sh`. `infra/nginx.conf`
remains the alternative for a machine that has such an nginx.
