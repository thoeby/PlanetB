"""Why one tile is not finished, read straight out of the database.

A worker says "stale" or "no published child" and stops there, because from
inside a browser tab that is all there is to say. The answer is in four tables:
what version the tile is expected at, what it has published, which jobs were
opened for which version, what their atoms are doing, and — for a merge — which
children were pinned and which of those the world has actually published.

This only reads (Invariant 9: nothing here computes or decides anything).
"""
from __future__ import annotations

import psycopg

from .config import Config

TILE = """
SELECT expected_version, published_version, dirty, sog_sha256,
       manifest IS NOT NULL AS has_manifest
FROM tile WHERE z = %s AND x = %s AND y = %s
"""

JOBS = """
SELECT id, target_version, state, bounty, created_at
FROM job WHERE z = %s AND x = %s AND y = %s
ORDER BY id
"""

ATOMS = """
SELECT a.id, a.op, a.state, a.attempts, a.worker_id IS NOT NULL AS held,
       a.inputs -> 'children' AS children,
       a.op <> 'merge' OR merge_has_a_child(a.inputs) AS foldable
FROM atom a WHERE a.job_id = %s ORDER BY a.id
"""

CHILDREN = """
SELECT z, x, y, expected_version, published_version, sog_sha256
FROM tile
WHERE z = %s AND x BETWEEN %s AND %s AND y BETWEEN %s AND %s
ORDER BY x, y
"""


def report(cfg: Config, z: int, x: int, y: int, out=print) -> int:
    with psycopg.connect(cfg.dsn(), autocommit=True, connect_timeout=10) as conn:
        row = conn.execute(TILE, (z, x, y)).fetchone()
        if not row:
            out(f"{z}/{x}/{y} is not a tile in this world — nothing has ever"
                " dirtied it, so no job can be opened for it.")
            return 1
        expected, published, dirty, sog, manifest = row
        out(f"tile {z}/{x}/{y}")
        out(f"  expected_version   {expected}")
        out(f"  published_version  {published}"
            + ("" if published == expected else "   <- behind"))
        out(f"  dirty              {dirty}")
        out(f"  sog                {sog or '(none)'}"
            + ("" if manifest or not sog else "   <- no manifest"))

        jobs = conn.execute(JOBS, (z, x, y)).fetchall()
        offered = "a job whose target is the tile's own version"
        if not jobs:
            out("\nno job has ever been opened for this tile")
        for jid, target, state, bounty, made in jobs:
            stale = "" if target == expected else (
                f"   <- publishes at {target}, the tile wants {expected}")
            out(f"\njob {jid}  target_version {target}  {state}"
                f"  bounty {bounty}  opened {made:%Y-%m-%d %H:%M}{stale}")
            for (aid, op, astate, tries, held, children,
                 foldable) in conn.execute(ATOMS, (jid,)):
                line = (f"  atom {aid:<5} {op:<9} {astate:<10}"
                        f" attempts {tries}{'  held' if held else ''}")
                if op == "merge":
                    named = [c for c in (children or []) if c]
                    line += f"  children pinned: {len(named)}/16"
                # Exactly what claim_atom asks, so a worker being given an atom
                # that cannot succeed is visible here rather than in a log.
                if astate == "ready":
                    why = []
                    if target != expected:
                        why.append(f"its job compiles {target}, the tile wants "
                                   f"{expected}")
                    if not foldable:
                        why.append("no child is pinned to fold")
                    line += ("  -> would be offered" if not why
                             else f"  -> NOT offered: {'; '.join(why)}")
                out(line)

        _children(conn, z, x, y, out)
    return 0


def _children(conn, z: int, x: int, y: int, out) -> None:
    """What is under this tile, since a merge can only be as done as they are."""
    if z >= 14:
        out("\nthis tile is built from the ground itself, not from children")
        return
    rows = conn.execute(CHILDREN,
                        (z + 2, x * 4, x * 4 + 3, y * 4, y * 4 + 3)).fetchall()
    if not rows:
        out(f"\nno tile exists at z{z + 2} under this one: nothing finer was"
            " ever dirtied here, so this tile is a leaf and is assembled"
            " rather than merged (db/0045_coarseleaf.sql)")
        return
    done = [r for r in rows if r[5]]
    out(f"\nchildren at z{z + 2}: {len(rows)} exist, {len(done)} published")
    for cz, cx, cy, cexp, cpub, csog in rows:
        mark = "published" if csog else "not published yet"
        out(f"  {cz}/{cx}/{cy}  version {cpub}/{cexp}  {mark}")
    if not done:
        out("  -> a merge here has nothing to fold, and should not have been"
            " planned (db/0035_mergeready.sql, db/0051_sharedbytes.sql)")
