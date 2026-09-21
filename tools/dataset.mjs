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
//   node tools/dataset.mjs <job id> [out dir] [--all]
//
// SPLATWORLD_API and SPLATWORLD_FILES name the world (default: the dev
// server, http://localhost:8080/api and http://localhost:8080).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataset } from '../client/lib/dataset.js';
import { unpackMeshes } from '../client/lib/mesh.js';
import { shuffled } from '../client/lib/preview.js';
import { rngOf, seedSurfaces } from '../client/lib/sampling.js';
import { readTar } from '../client/lib/tar.js';
import { GROUND_FLOOR, SEED_SHARE, SPREAD } from '../client/atoms/train.js';

const API = process.env.SPLATWORLD_API ?? 'http://localhost:8080/api';
const FILES = process.env.SPLATWORLD_FILES ?? 'http://localhost:8080';

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

// The seed the trainer makes from the assembled meshes, the way it makes it.
function seedOf(files, train) {
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const p = train?.params ?? {};
    const budget = Number(p.budget) || scene.budget;
    const { z, x, y } = scene.tile;
    const random = rngOf(train ?? { seed: 0 }, z, x, y);
    const share = Number(p.seed_share) || SEED_SHARE;
    const floor = p.ground_floor === undefined ? GROUND_FLOOR : Number(p.ground_floor);
    return { scene, seed: shuffled(seedSurfaces(meshes, Math.round(budget * share), random,
        { spread: SPREAD, even: true, floor }), random) };
}

async function main([job, out = `dataset-${job}`, ...flags]) {
    if (!job) throw new Error('usage: node tools/dataset.mjs <job id> [out dir] [--all]');
    const atoms = await rows('atom',
        `job_id=eq.${job}&select=id,op,params,seed,output_sha256,result&order=id`);
    const ds = atoms.find((a) => a.op === 'dataset');
    if (!ds?.output_sha256) throw new Error(`job ${job}: the dataset is not made yet`);
    const tar = await bytes(ds);
    const files = readTar(tar);
    const all = flags.includes('--all');
    const train = atoms.find((a) => a.op === 'train');
    const { scene, seed } = seedOf(files, train);
    const set = ds.params?.camera_set;
    const written = all ? [...files].map(([name, b]) => ({ name, bytes: b }))
        : dataset([tar], set, seed).files;
    for (const f of written) {
        const to = join(out, f.name);
        mkdirSync(join(to, '..'), { recursive: true });
        writeFileSync(to, f.bytes);
    }
    const { z, x, y } = scene.tile;
    console.log(`${out}: tile ${z}/${x}/${y}, ${written.length} files of ${set}`
        + `${all ? '' : ` as the trainer saw them, ${seed.count} seed splats`}`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
