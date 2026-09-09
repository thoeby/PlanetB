# Runbook

For the person on call. Four processes (postgres, postgrest, geoserver, nginx)
and two halves of state: the **database**, which names things, and the
**file store**, which holds the bytes. Everything below is about keeping those
two halves level.

Export the environment first — every tool reads `PG*`, `JWT_SECRET` and
`FILES_ROOT` from it, and the Makefile is not in the loop:

```
set -a; . ./.env; set +a
```

## 0. Why the two halves are the whole story

Every writer puts the bytes down **before** the row that names them:
`client/js/work.js` PUTs and then calls `register_artifact`; `tools/seed-dem.sh`
cuts a tile and then calls `geo_register`. Two kinds of drift follow, and they
are not equally bad.

| drift | how bad |
|---|---|
| bytes in the store, no `artifact` row | litter. Costs disk. A worker that computes the same bytes gets a 409 from nginx and carries on. |
| an `artifact` row with no bytes | **unrecoverable.** `can_write` refuses a PUT of a sha256 that is already registered (`db/0008_files.sql`), so nobody can ever supply those bytes again. Whatever named them is dead. |

That asymmetry decides every order in this document:

* **back up the database first, the files second.** A dump taken before the
  copy can only name artifacts whose bytes were already on disk. The other way
  round the dump names bytes written after the copy started.
* **restore the files first, the database second.** For the same reason, read
  backwards: at no moment does a live database name bytes the store lacks.

`tools/backup.sh` and `tools/restore.sh` do it in those orders. That is most of
why they are scripts and not three lines of prose here.

## 1. Backup

```
bash tools/backup.sh /srv/backups
```

```
backup: pg_dump splatworld -> /srv/backups/20260909T065028Z/db.dump
backup: hard-linking unchanged files against /srv/backups/20260908T065011Z
backup: copied assets
backup: copied tiles
stamp          20260909T065028Z
database       splatworld @ localhost:5432
files_root     /srv/files
dirs           assets tiles
order          pg_dump first, then rsync
dump_bytes     231287
assets.files   1
assets.bytes   2048
tiles.files    3
tiles.bytes    5376
git            f8fc988
```

Green is: a `db.dump` with a plausible size, a `manifest.txt`, and file counts
that do not go **down** between runs. Artifacts are immutable, so the store only
ever grows; a count that fell means somebody deleted bytes.

Every run after the first hard-links the unchanged files against the previous
run, so a nightly backup of a hundred gigabyte store costs a hundred gigabytes
once and the new tiles thereafter. Do not "clean up" old backup directories with
anything that follows hard links.

**What is not in the backup, and why**

* `/jobs` — intermediate output of atoms, deleted by `tools/gc-jobs.sh` a week
  after a job finishes. Backing it up would be backing up scratch.
* `/geo` — the pre-cut DEM and ortho tiles. They are addressed by tile
  coordinates rather than by hash and are re-cut idempotently by
  `tools/seed-dem.sh` and `tools/seed-ortho.sh`, which re-register what is
  already on disk (PROGRESS deviation 71). Restoring them means re-running the
  seeds, which takes minutes and network, not a restore.
* roles and per-database settings — see §3.

Both are opinions, not laws: `BACKUP_DIRS='assets tiles geo jobs'` backs up
everything if you would rather buy the disk than run a seed at 3 am.

## 2. Restore

The drill below was run end to end on 2026-09-09 against a scratch database and
a scratch store: one published z14 tile with its height and colliders, one
catalog asset, one finished job and one open one. `tools/ops-test.sh` runs the
same drill on every `make gate`, so it is not allowed to rot.

**Destroy both halves.**

```
$ dropdb --force splatworld
$ rm -rf /srv/files
```

**Put them back.**

```
$ FILES_ROOT=/srv/files PGDATABASE=splatworld bash tools/restore.sh /srv/backups/20260909T065028Z
restore: files assets
restore: files tiles
restore: created splatworld
restore: app.jwt_secret re-applied from $JWT_SECRET
drift: 4 paths named by splatworld, 0 of them missing from /srv/files
drift: 0 file(s) in the store that no artifact row knows about
```

**Check it is a world again.**

```
$ psql -t -A -c "SELECT count(*) FROM artifact"
7
$ psql -t -A -c "SELECT length(login('someone@example.com','their-password')) > 40"
t
```

Green is the two `drift:` lines both reading zero, and `login` returning a
token. `tools/restore.sh` exits non-zero if any named path is missing, so it can
be the last line of a cron.

Then restart PostgREST — it caches the schema at connect time — and re-run
`bash tools/api-test.sh` for a smoke test.

**What restore does not put back**

* `/jobs`. A job that was mid-flight when the backup ran does not survive: its
  atoms come back from the dump marked `verified` with an `output_sha256` whose
  bytes are gone, and nothing can upload them again. Bump the tile instead —
  any edit inside the area raises `expected_version`, which makes `ensure_job`
  build a *new* job with new atom hashes, and the tile compiles from scratch.
  Published tiles are unaffected; their bytes live under `/tiles`.
* `/geo`. Re-run `bash tools/seed-dem.sh && bash tools/seed-ortho.sh`.

## 3. Two things `pg_dump` does not carry

**`app.jwt_secret` is a per-database setting**, written by `ALTER DATABASE …
SET`, and `pg_dump` does not dump those (only `pg_dumpall` does). Without it
nothing can log in, and the error does not mention the restore at all:

```
ERROR:  app.jwt_secret is unset or shorter than 32 chars
CONTEXT:  PL/pgSQL function jwt_secret() line 6 at RAISE
SQL function "sign" statement 1
```

`tools/restore.sh` re-applies it from `$JWT_SECRET` and says so. If you restored
by hand:

```
psql -d postgres -v d=splatworld -v s="$JWT_SECRET" -f - <<'SQL'
ALTER DATABASE :"d" SET app.jwt_secret = :'s';
SQL
```

(`psql` interpolates `:'…'` in a script but not in `-c`.)

**Roles are cluster objects.** `anon`, `player`, `admin`, `authenticator` and
`geoserver` live in the cluster, not in the database, so a restore onto a fresh
cluster fails on the first `GRANT`. Create them by applying `db/0001_schema.sql`,
`db/0007_api.sql` and `db/0008_admin.sql` to a throwaway database with the right
`-v authpw=` / `-v geopw=`, or keep a `pg_dumpall --globals-only` beside the
dumps. Note that those two migrations end in `ALTER ROLE … PASSWORD`: running
them with the wrong password locks the running PostgREST out of the *live*
database, because there is only one `authenticator` per cluster.

## 4. When the halves have drifted

```
bash tools/restore.sh --check
```

It asks the database where every published tile's `.sog`, height and colliders
are, and where every catalog asset and thumbnail is, and looks. Then it counts
the store's files that no `artifact` row knows about.

```
  missing bytes: /tiles/14/8565/5735/68e6ac4e…d27.sog
drift: 4 paths named by splatworld, 1 of them missing from /srv/files
drift: 0 file(s) in the store that no artifact row knows about
```

Exit status is 0 when nothing is missing and 1 when something is.

**`missing bytes` — the store has lost something.** Fill it in from the last
backup. This never overwrites: a path that is already there holds the bytes its
name says it holds (Invariant 1), so it is safe to run against a live store.

```
$ bash tools/restore.sh /srv/backups/20260909T065028Z --files-only
restore: files assets
restore: files tiles
drift: 4 paths named by splatworld, 0 of them missing from /srv/files
```

If no backup has them either, the artifact is gone for good. For a published
tile: edit anything in the area to bump `expected_version` and let the world
recompile it. For a catalog asset: the uploader has to upload it again, and
because the sha is registered they cannot — delete the `asset` row and let them
publish it as a new one.

**Files nothing knows about.** Harmless. Usually an interrupted seed or an
upload whose `register_artifact` never landed. `tools/seed-dem.sh` and
`tools/seed-ortho.sh` re-register what they find on disk, so re-running the
seeds is the fix for `/geo`; elsewhere leave it, or delete it once you have
convinced yourself no `atom.result` names it.

**On a development box, expect it to be red.** `db/test/0006_concurrency.sh`
publishes hundreds of tiles by SQL with invented sha256s and never uploads a
byte, so a box that has run `make db-test` reports every one of them as missing:

```
drift: 499 paths named by splatworld, 499 of them missing from ./infra/files
```

Check who published them before believing it (`SELECT u.email, count(*) FROM
tile t JOIN auth.user u ON u.id = t.published_by … GROUP BY 1`); `w*@torture.test`
means the torture test, not a lost store. On a server every publisher is a real
player and the count should be zero.

**The one that looks like a permissions bug.** A PUT returning 403 with
`artifact already registered` means the row is there and the bytes are not, or
the bytes are somewhere else in the store. That is the second row of the table
in §0. Check with `--check` before believing it is a token problem.

## 5. Garbage collection

`/jobs/{atom_id}/…` holds what atoms uploaded on the way to a published tile.
A week after a job is done, that is dead weight.

```
$ bash tools/gc-jobs.sh
gc-jobs: 1 file(s), 8192 byte(s), in jobs done and untouched for 7 day(s)
gc-jobs: no atom row for jobs/999999999
  would delete /jobs/1/6dc1fc6e…381.tar
gc-jobs: dry run, nothing deleted. Pass --apply.

$ bash tools/gc-jobs.sh --apply
gc-jobs: 1 file(s), 8192 byte(s), in jobs done and untouched for 7 day(s)
gc-jobs: deleted 1 file(s)
```

It is a dry run unless told otherwise. It is safe to run while tabs are working,
with one gap worth knowing: the plan is a query and the delete is a loop after
it, so a job that `recheck_atom` re-opens in between is not caught. The seven-day
window is what makes that uninteresting — a file nobody has written for a week is
not one a job is about to read this second. `--days N` widens it.

**What it will never delete**

* Anything in a job that is not `done`, or that any atom has claimed or beaten
  within the window.
* Any path an atom of a live job names — `result.path` or any entry of
  `result.files`. This is the case that makes the whole thing delicate: an
  artifact is written once, so an atom that computes bytes another atom already
  uploaded records *that* atom's path (`client/js/work.js` `elsewhere()`), and a
  live job's input therefore sits inside a dead job's directory perfectly
  normally.
* Anything an unfinished atom is going to **read** — everything its `deps` and
  its `inputs` name, and whatever those producers wrote. A consumer resolves a
  numeric input to the producer's own path (`client/js/inputs.js`), and
  `new_atom` dedups `atom_hash` across jobs, so that producer is routinely in an
  older, settled job. This is the one that bites: it is not enough to protect
  what live atoms produced.
* Any file whose sha256 is still named by a `tile` pointer or its manifest, or
  by an `asset` row.
* Any file touched inside the window, by mtime, whatever the database says.
* A directory with no `atom` row at all. It reports those (`no atom row for
  jobs/…`) and leaves them, because bytes whose atom is gone may be the only
  copy of an artifact somebody registered. `tools/test-tiles.sh` is what clears
  those after a `make db-reset`.

Green is the byte count going down and the store still passing `--check`.

## 6. PUT rate limits

`infra/nginx.conf`:

```
limit_req_zone $binary_remote_addr zone=put:10m rate=20r/s;
limit_req_status 429;
limit_conn_zone $binary_remote_addr zone=putconn:10m;
…
location @put {
    limit_req zone=put burst=100 nodelay;
    limit_conn putconn 32;
```

Reads are not limited: a GET is a `sendfile` and the store is meant to be a
CDN-shaped thing. A PUT costs an `auth_request` round trip to PostgREST and a
file on disk, so only writes are counted, per client address.

**Why 20 r/s and a burst of 100.** A worker's PUTs are separated by the seconds
or minutes an atom takes to compute; the only genuine bursts are the three files
a `sog` atom delivers at once and the two a catalog upload makes. 100 leaves
room for twenty tabs behind one office address — the WP5 gate's number — all
delivering at the same instant, and the bucket refills in five seconds.

Measured on this box, from nginx's own logs. The most PUT-dense thing in the
repo is `tools/test-tiles.sh`, which fabricates seven tiles' artifacts with no
rendering in between: its busiest second holds **20 PUTs**, and the busiest
second in the whole store log is **24**. The browser tests peak at **4**. Twenty
over the limit for one second spends four of the hundred the burst allows. Over
452 logged PUTs — 74 of them after the limit went in — the error log contains no
`limiting requests` line at all.

**A 429 is not graceful.** `client/js/work.js` treats any PUT status other than
201/204/409/403 as a failure and loses the atom, which then expires and is
re-claimed by someone else. That is the reason for the wide burst: the limit
exists to stop a runaway loop, not to shape normal traffic. If you see 429s in
`error.log` from a real address, raise `burst` rather than `rate` — bursts are
what tabs do.

`limit_conn putconn 32` caps simultaneous uploads per address and answers 503,
not 429 (`limit_conn_status` is not set). Thirty-two concurrent uploads from one
address is already more than twenty tabs can produce.

`tools/ops-test.sh` reads both numbers out of `infra/nginx.conf` and asserts
that nine tenths of the burst is never limited and that three times it is, so
re-tuning the config re-tunes the test — and that the burst leaves room for at
least one request, because a test that sends nothing passes whatever the limit.

## 7. Cron

```
15 3 * * *  cd /srv/splatworld && set -a && . ./.env && set +a && bash tools/backup.sh /srv/backups
45 3 * * 0  cd /srv/splatworld && set -a && . ./.env && set +a && bash tools/gc-jobs.sh --apply
0  4 * * *  cd /srv/splatworld && set -a && . ./.env && set +a && bash tools/restore.sh --check
```

**Whether these run on the server is the owner's call, not this document's.**
CLAUDE.md's layout annotates `tools/` as "runs on the dev box, not the server",
and Invariant 9 forbids a cron that computes. The reading that lets these three
through is that none of them computes anything about the world — a backup copies
bytes, the GC deletes bytes, the drift check reads — and that a world with no
backup is worse. It is still a reading. Run them from wherever `psql` and the
store are both reachable; a dev box with a mount is as good as the server, and
does not need the argument at all.

## 8. Dependencies

`pg_dump`, `pg_restore`, `createdb`/`dropdb`, and `rsync`. `rsync` is what
`tools/backup.sh` and `tools/restore.sh` prefer; both fall back to `cp -al` plus
a non-overwriting `cp` if it is missing, which is slower and does the same
thing. On Debian/Ubuntu: `apt-get install -y rsync`.
