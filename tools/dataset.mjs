#!/usr/bin/env node
// dataset.mjs — a tile's dataset, unpacked into the folder brush's app takes.
//
// A tile's dataset atom (client/atoms/dataset.js) writes one tar: the
// assembled scene, the seed, every frame and transforms.json. This fetches it
// for a job and unpacks it. By default the four poses the trainer holds back
// for verification are left out and init.ply is the seed the trainer makes,
// so the folder is exactly what brush was handed; --all keeps every frame and
// the assemble's own init.ply.
//
//   node tools/dataset.mjs <job id> [out dir] [--all] [--without ring,oblique,top]
//                          [--args] [--trained]
//
// --without leaves out every frame of those kinds, to ask brush's app what a
// kind of view does to the result: the rings are the far, low views of
// z16-v3, the stations are the rest.
//
// --args writes args.txt, which brush's app reads from the folder as its
// command line: the train atom's own config (client/lib/brush.js configFor),
// so the app trains with exactly what the atom does rather than its defaults.
// --trained writes trained.ply beside it: the splats the atom got back from
// brush, kept to the tile (client/atoms/train.js keep) and before the .sog,
// its levels and the viewer's budget. Opened in the app next to its own run,
// it says whether a hole is the training's or what came after.
//
// SPLATWORLD_API and SPLATWORLD_FILES name the world (default: the dev
// server, http://localhost:8081/api and http://localhost:8081).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFor } from '../client/lib/brush.js';
import { dataset } from '../client/lib/dataset.js';
import { unpackMeshes } from '../client/lib/mesh.js';
import { shuffled } from '../client/lib/preview.js';
import { rngOf, seedOf as placeSeed } from '../client/lib/sampling.js';
import { readTar } from '../client/lib/tar.js';

const API = process.env.SPLATWORLD_API ?? 'http://localhost:8081/api';
const FILES = process.env.SPLATWORLD_FILES ?? 'http://localhost:8081';

async function rows(table, query) {
    const res = await fetch(`${API}/${table}?${query}`);
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    return res.json();
}

async function bytes(atom) {
    const path = atom.result?.path ?? `/jobs/${atom.id}/${atom.output_sha256}.tar`;
    const res = await fetch(FILES + path);
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

// The train atom's config as brush's command line: the keys configFor sets,
// in its kebab-case names, minus the ones that only mean something to the
// atom (evaluation and export cadence, a null split).
const ATOM_ONLY = new Set(['eval-split-every', 'eval-every', 'export-every']);

function argsFor(train, size) {
    const p = train?.params ?? {};
    const c = configFor({}, { iters: Number(p.iters), budget: Number(p.budget), size,
        seed: train?.seed ?? 42, refineEvery: Number(p.refine_every) || 0, tuning: p.brush });
    return Object.entries(c).filter(([k, v]) => !ATOM_ONLY.has(k) && v != null)
        .map(([k, v]) => `--${k} ${v}`).join('\n');
}

// The seed the trainer makes from the assembled meshes, the way it makes it
// (client/lib/sampling.js seedOf, under the train atom's own params).
function seedOf(files, train) {
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const p = train?.params ?? {};
    const budget = Number(p.budget) || scene.budget;
    const { z, x, y } = scene.tile;
    const random = rngOf(train ?? { seed: 0 }, z, x, y);
    return { scene, seed: shuffled(placeSeed(meshes, budget, random, p).seed, random) };
}

async function main([job, out = `dataset-${job}`, ...flags]) {
    if (!job) {
        throw new Error('usage: node tools/dataset.mjs <job id> [out dir] [--all]'
            + ' [--without kinds] [--args] [--trained]');
    }
    const atoms = await rows('atom',
        `job_id=eq.${job}&select=id,op,params,seed,output_sha256,result&order=id`);
    const ds = atoms.find((a) => a.op === 'dataset');
    if (!ds?.output_sha256) throw new Error(`job ${job}: the dataset is not made yet`);
    const tar = await bytes(ds);
    const files = readTar(tar);
    const all = flags.includes('--all');
    const at = flags.indexOf('--without');
    const without = at >= 0 ? String(flags[at + 1] ?? '').split(',').filter(Boolean) : [];
    const train = atoms.find((a) => a.op === 'train');
    const { scene, seed } = seedOf(files, train);
    const set = ds.params?.camera_set;
    const written = all && !without.length ? [...files].map(([name, b]) => ({ name, bytes: b }))
        : dataset([tar], set, seed, { all, without }).files;
    for (const f of written) {
        const to = join(out, f.name);
        mkdirSync(join(to, '..'), { recursive: true });
        writeFileSync(to, f.bytes);
    }
    if (flags.includes('--args')) {
        writeFileSync(join(out, 'args.txt'), `${argsFor(train, Number(train?.params?.size)
            || Number(ds.params?.size))}\n`);
    }
    if (flags.includes('--trained')) {
        if (!train?.output_sha256) throw new Error(`job ${job}: the tile is not trained yet`);
        const ply = readTar(await bytes(train)).get('splats.ply');
        if (!ply) throw new Error(`job ${job}: the train artifact holds no splats.ply`);
        writeFileSync(join(out, 'trained.ply'), ply);
    }
    const { z, x, y } = scene.tile;
    console.log(`${out}: tile ${z}/${x}/${y}, ${written.length} files of ${set}`
        + `${without.length ? ` without ${without.join(', ')}` : ''}`
        + `${all ? '' : ` as the trainer saw them, ${seed.count} seed splats`}`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
