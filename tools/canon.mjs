#!/usr/bin/env node
// canon.mjs — a GLB as the catalog names it, for tools/register.py (LV.8).
//
//   node tools/canon.mjs model.glb out.glb [marks.json]
//
// Runs client/lib/canon.js — the one canonicaliser, the same bytes the page
// makes — with the nodes the markings keep apart, writes the canonical GLB to
// out.glb and prints {sha256, canon_version, meta} as JSON. A model that needs
// a texture shrunk or a Draco mesh inflated says so: node has neither decoder,
// and a second canonical form would be a second product.

import { readFileSync, writeFileSync } from 'node:fs';

import { canonicalise } from '../client/lib/canon.js';
import { partNodes } from '../client/lib/marks.js';

const [src, out, marksFile] = process.argv.slice(2);
if (!src || !out) {
    console.error('usage: node tools/canon.mjs model.glb out.glb [marks.json]');
    process.exit(2);
}
const marks = marksFile ? JSON.parse(readFileSync(marksFile, 'utf8')) : {};
const done = await canonicalise(new Uint8Array(readFileSync(src)), { parts: partNodes(marks) });
writeFileSync(out, done.glb);
process.stdout.write(`${JSON.stringify({ sha256: done.sha256,
    canon_version: done.canon_version, meta: done.meta })}\n`);
