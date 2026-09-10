#!/usr/bin/env node
// Freezes a compiled world into a folder of plain files:
//
//     node tools/export-world.mjs --out ./world-export
//
// What comes out is the viewer, the tile list as index.json, and the .sog tiles
// themselves. Copy that folder onto any web host — shared hosting included — and
// the link is the world. Nothing runs there: no database, no API, no uploads.
//
// Dev-box tooling, like the rest of tools/. It reads the database and the file
// store and writes files; it computes nothing about the world (Invariant 9).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const repo = resolve(dirname(new URL(import.meta.url).pathname), '..');
const out = resolve(arg('out', './world-export'));
const filesRoot = resolve(arg('files', process.env.FILES_ROOT ?? join(repo, 'infra/files')));

const psql = (sql) => execFileSync('psql', [
    '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A',
    '-d', process.env.PGDATABASE ?? 'splatworld', '-c', sql,
], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

// Every row, published or not: refinableInto() has to tell an unpublished child
// from ground nobody has drawn on, or the viewer tears holes in the terrain.
const rows = JSON.parse(psql(`
    SELECT coalesce(json_agg(t ORDER BY t.z, t.x, t.y), '[]'::json) FROM (
        SELECT z, x, y, dirty, published_version, sog_sha256, manifest FROM tile
    ) t`) || '[]');

const live = rows.filter((r) => r.published_version > 0 && r.sog_sha256);
if (!live.length) {
    console.error('export: this world has no published tiles yet — nothing to look at.');
    process.exit(1);
}

mkdirSync(out, { recursive: true });

// The viewer and the modules it imports. Copied whole rather than traced: they
// are a few hundred kB of plain ES modules and tracing imports would rot.
for (const p of ['js', 'lib', 'view.html']) {
    cpSync(join(repo, 'client', p), join(out, p), { recursive: true });
}
// The engine, if `make vendor` has fetched it — only PlayCanvas, not the rest
// of client/vendor/, which the viewer never loads. Without it view.html falls
// back to the CDN, which needs the visitor to have a network.
const engine = join(repo, 'client/vendor/playcanvas');
if (existsSync(engine)) cpSync(engine, join(out, 'vendor/playcanvas'), { recursive: true });

writeFileSync(join(out, 'index.json'), `${JSON.stringify(rows)}\n`);

// index.html so the folder works as a bare link, without /view.html on the end.
cpSync(join(repo, 'client/view.html'), join(out, 'index.html'));

let copied = 0;
let bytes = 0;
const missing = [];
for (const t of live) {
    const rel = join('tiles', String(t.z), String(t.x), String(t.y), `${t.sog_sha256}.sog`);
    const src = join(filesRoot, rel);
    if (!existsSync(src)) { missing.push(rel); continue; }
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    cpSync(src, join(out, rel));
    copied += 1;
    bytes += statSync(src).size;
}

const mb = (bytes / 1e6).toFixed(1);
console.log(`export: ${rows.length} tile rows, ${copied} tiles copied (${mb} MB)`);
if (missing.length) {
    console.log(`export: ${missing.length} published tile(s) missing from ${filesRoot}:`);
    for (const m of missing.slice(0, 5)) console.log(`  ${m}`);
}
console.log(`export: written to ${out}`);
console.log('export: upload that folder anywhere, or open index.html through a web server.');
