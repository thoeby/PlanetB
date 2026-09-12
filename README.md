# splatworld

A persistent world on real geography. You draw it in QGIS; browser tabs compile
what you drew into Gaussian-splat tiles; you walk around in it. No server-side
compute, no build step, no Docker required.

**Start here: [Quick start](#quick-start).** Everything else is below it.

---

## Quick start

On Windows, macOS or Linux, with nothing installed yet. About twenty minutes,
most of it waiting for PostgreSQL to download.

### 1. Install two things

**PostgreSQL 16 with PostGIS** — the only piece that can't come from pip.

- Windows: the [postgresql.org installer](https://www.postgresql.org/download/windows/).
  At the end it offers *Stack Builder* — tick **PostGIS** there. **Write down
  the password you set for the `postgres` user.**
- Debian/Ubuntu: `apt install postgresql-16-postgis-3`
- macOS: [Postgres.app](https://postgresapp.com/), PostGIS is built in.

**PostgREST** — one file, no installer. Take the build for your machine from
[its releases](https://github.com/PostgREST/postgrest/releases) and put it
somewhere on your `PATH`.

### 2. Get splatworld

```sh
git clone <this repo> PlanetB
cd PlanetB
python -m pip install -e ./server
```

Use `-e`. It links to this folder, so `git pull` is enough afterwards. A plain
`pip install ./server` copies the code, and then every pull changes nothing
about what runs — which looks exactly like a fix not working. (`splatworld run`
refuses to start in that state and tells you this.)

### 3. Tell it the database password

Make a file called `.env` next to this README:

```
PGPASSWORD=whatever-you-set-during-install
```

That is the only thing you ever have to type into a file. Everything else is
remembered by the setup page.

### 4. Run it

```sh
splatworld run
```

It creates the database, applies the schema, starts PostgREST, serves the
client, and opens the browser at the setup page. Leave it running; `Ctrl-C`
stops it. Later `git pull`s apply their own migrations on the next `run`.

It prints the address it is serving on — usually `http://127.0.0.1:8080`, but
if something else holds that port (GeoServer often does) it moves up and says
so. The pages are told which port they landed on, so nothing needs editing.

Stuck? `splatworld doctor` prints everything it resolved and what is missing.

### 5. Setup page — three steps, once

| | |
|---|---|
| **1 · Your account** | an email and a password (8+ characters). You sign in with it, and QGIS draws as it. |
| **2 · Your GeoServer** | the address that opens its pages, e.g. `localhost:8081/geoserver`, and a login that may read your elevation. **Connect** asks its WCS what it publishes. Nothing is created on it: it serves the elevation and nothing else. |
| **3 · Elevation** | after you have drawn an area, this works out the region from what you drew and fetches free Copernicus elevation for exactly that. Nothing to type. |

You need a GeoServer for step 2 — [it's a zip and a script](https://geoserver.org/download/),
no installer — with your elevation published as a coverage store
([`docs/geoserver.md`](docs/geoserver.md)). It is the elevation source and
nothing else.

### 6. Draw something in QGIS

1. In the page: **Your land → Shape this land in QGIS**. You get a `.qgs` with
   your own database login in it.
2. Open it in QGIS. The layers are there, with the hillshade under them.
3. Pick a layer — Wood, Road, Single tree — press the pencil
   (*Toggle Editing*), draw, fill in the form, **Save Layer Edits**.
4. The page has it within half a minute: the Land card says how many tiles
   changed.

There is nothing else to fill in: the area a feature belongs to, its kind and
its revision are worked out from what you drew and where. QGIS connects as
**you**, so you can draw on your own land and nowhere else, and what it
refuses it refuses in words ([`gis/README.md`](gis/README.md)).

### 7. Compile and walk around

Back on the setup page press **Fetch elevation**, then open `/app/play.html`
on the address `splatworld run` printed, and turn on background work. The tabs
compile what you drew, tile by tile, and the viewer streams it.

---

## When something goes wrong

| | |
|---|---|
| QGIS says *Error inserting features* | Setup page → **Why did the last save fail?** It reads the Postgres log and shows the actual reason — GeoServer swallows it. |
| Something ended up in the wrong place | The database refuses a geometry outside the world's ground and says whether its coordinates are the wrong way round; draw with the project the page hands you. |
| *libpq.dll was not found* (Windows) | PostgREST does not ship it. Put PostgreSQL's `bin` directory — the one with `psql.exe` — on PATH. `splatworld run` does this for you when it can find that directory. |
| *Could not find a version that satisfies setuptools* when installing | `pip` could not reach an index to build in isolation: `python -m pip install -U pip setuptools wheel` then `python -m pip install --no-build-isolation -e ./server`. |
| A fix from `git pull` seems to do nothing | The setup page shows a red bar when the server answering it is older than the page, and the setup buttons refuse to run stale code. Restart `splatworld run`; if it persists, `python -m pip install -e ./server`. |
| Anything else | `splatworld doctor` |

## The documentation

| | |
|---|---|
| [`docs/server.md`](docs/server.md) | running it: settings, commands, ports, running it on a real server |
| [`docs/geoserver.md`](docs/geoserver.md) | what to publish on GeoServer, and what the world asks it |
| [`docs/import.md`](docs/import.md) | importing elevation and layers you already have |
| [`docs/manual.md`](docs/manual.md) | everything: deployment, operations, the whole feature set |
| [`docs/runbook.md`](docs/runbook.md) | operating a live world |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how it works and why |
| [`CLAUDE.md`](CLAUDE.md) | the invariants — read before changing anything |

## How it fits together

```
QGIS  ───SQL, as you───────────────────▶  PostgreSQL          the world
                                            │
                                     trigger marks
                                     tiles dirty
                                            │
                                            ▼
                               browser tab claims the work,
                               compiles it, publishes it
                                            │
                                            ▼
                                    play.html streams it
```

Four processes, and none of them computes anything about the world:
PostgreSQL, PostgREST (the only API — row-level security authorises every
write), the `splatworld` server (files and static pages), and GeoServer
(admin and visualisation only). Every atom — assemble, frame, train, merge,
sog, verify — runs in a browser tab. Publishing a tile is a compare-and-swap
in Postgres.
