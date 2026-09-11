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
PATH, or point the `POSTGREST` environment variable at it. It stays the API:
the schema's grants and row-level security are what authorise every write
(Invariant 6), and none of that survives being reimplemented.

Then `python -m pip install -e ./server` from the checkout.

## Settings

`splatworld doctor` prints everything it resolved and what is not ready yet.

Settings come from the environment, or from a `.env` beside the checkout (the
same file the Makefile reads), or from flags — later wins.

| | |
|---|---|
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | the database. Set `PGPASSWORD` to what you chose during install |
| `JWT_SECRET` | signs sign-ins. Anything ≥ 32 characters. **Change it** before anyone else can reach the machine |
| `SPLATWORLD_PORT` | where the client and files are served, default 8080. If that port is taken — or reserved, which Windows does to whole ranges for Hyper-V and WSL — it moves up until one is free and says so. The pages are told which port they landed on, so nothing needs editing. |
| `SPLATWORLD_API_PORT` | PostgREST, default 3000 |
| `FILES_ROOT` | where tiles are written, default `infra/files/` |
| `POSTGREST` | path to the binary, if it is not on PATH |
| `SPLATWORLD_REPO` | the checkout, if the package was installed from elsewhere |

## The pages it serves

| | |
|---|---|
| `/app/import.html` | pick layers off a GeoServer or this database and import them |
| `/app/rules.html` | the build rules: what a feature becomes, first match wins |
| `/app/play.html` | play, and compile tiles in your browser |
| `/app/edit.html` | the map editor |
| `/app/catalog.html` | the catalog |
| `/app/view.html` | the read-only viewer |
| `/assets /tiles /jobs /geo` | the file store: public to read, authorised to write |

## Commands

```
splatworld import <file>   import a region from the command line
splatworld init            create the database, apply db/*.sql
splatworld init --reset    drop it first — this deletes the whole world
splatworld run             start everything
splatworld run --verbose   show request and PostgREST logs
splatworld run --no-browser
splatworld doctor          what is ready, and what is not
```

## On a server

```
splatworld run --host 0.0.0.0
```

Then, before anyone else can reach it: a real `JWT_SECRET`, a real database
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
— which it passes unmodified, 15 assertions, alongside `tools/api-test.sh`'s
17. `infra/nginx.conf` remains the deployment other people use.
