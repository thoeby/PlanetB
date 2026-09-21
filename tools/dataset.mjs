#!/usr/bin/env node
// dataset.mjs — the exact dataset a tile's trainer hands brush, as one folder.
//
// A tile's frames are traced in atoms of twenty, so a job holds three or four
// frame tars and an assemble tar, and the only place they are ever one
// nerfstudio dataset is the tab's private storage while brush runs. This
// writes that dataset to disk — images, transforms.json and init.ply, the
// seed made the way the trainer makes it — so the same run can be repeated
// and looked at in brush's own app.
//
//   node tools/dataset.mjs <job id> [out dir] [--all]
//
// SPLATWORLD_API and SPLATWORLD_FILES name the world (default: the dev
// server, http://localhost:8080/api and http://localhost:8080). --all keeps
// the four poses the trainer holds back for verify.
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

async function main([job, out = `dataset-${job}`, ...flags]) {
    if (!job) throw new Error('usage: node tools/dataset.mjs <job id> [out dir] [--all]');
    const atoms = await rows('atom',
        `job_id=eq.${job}&select=id,op,params,seed,output_sha256,result&order=id`);
    const asm = atoms.find((a) => a.op === 'assemble');
    const train = atoms.find((a) => a.op === 'train');
    const frames = atoms.filter((a) => a.op === 'frame');
    if (!asm?.output_sha256) throw new Error(`job ${job}: the assemble is not done`);
    const missing = frames.filter((f) => !f.output_sha256);
    if (missing.length) {
        throw new Error(`job ${job}: frames ${missing.map((f) => f.id)} are not done`);
    }

    const files = readTar(await bytes(asm));
    const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const p = train?.params ?? {};
    const budget = Number(p.budget) || scene.budget;
    const { z, x, y } = scene.tile;
    const random = rngOf(train ?? { seed: 0 }, z, x, y);
    const share = Number(p.seed_share) || SEED_SHARE;
    const floor = p.ground_floor === undefined ? GROUND_FLOOR : Number(p.ground_floor);
    const seed = shuffled(seedSurfaces(meshes, Math.round(budget * share), random,
        { spread: SPREAD, even: true, floor }), random);

    const tars = [];
    for (const f of frames) tars.push(await bytes(f));
    const set = p.camera_set ?? frames[0]?.params?.camera_set;
    const ds = dataset(tars, set, seed, { all: flags.includes('--all') });
    for (const f of ds.files) {
        const to = join(out, f.name);
        mkdirSync(join(to, '..'), { recursive: true });
        writeFileSync(to, f.bytes);
    }
    console.log(`${out}: tile ${z}/${x}/${y}, ${ds.views} frames of ${set}`
        + `${ds.held ? ` (${ds.held} held back)` : ''}, ${seed.count} seed splats`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
