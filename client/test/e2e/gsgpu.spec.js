// The WebGPU trainer against the JS one.
//
// client/lib/gswgsl.js and client/lib/gswgslgrad.js are a transcription of
// client/lib/gsrast.js and client/lib/gsgrad.js, and a transcription is exactly
// the kind of thing that goes quietly wrong. Both are given the same gaussians,
// the same camera and the same target here, and have to agree — first on the
// image, then on where one step of Adam moves every parameter.
//
// A software adapter is enough for that; it is not enough for the eight minutes
// WP3.1 asks of a real one.

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { CLIENT } from './serve.js';

const PREINSTALLED = '/opt/pw-browsers/chromium';
const SIZE = 64;

// WebGPU is behind a flag in this build and needs a secure origin, so the page
// is served over localhost rather than intercepted.
test.use({
    launchOptions: {
        ...(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}),
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--disable-gpu-sandbox', '--enable-unsafe-webgpu'],
    },
});
test.describe.configure({ timeout: 300000 });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

function serveClient() {
    const server = createServer((req, res) => {
        const path = new URL(req.url, 'http://x').pathname;
        if (path === '/blank.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>t');
            return;
        }
        const p = join(CLIENT, path);
        if (!existsSync(p) || p.endsWith('/')) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'text/plain' });
        res.end(readFileSync(p));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1',
        () => resolve({ url: `http://localhost:${server.address().port}/blank.html`,
            stop: () => server.close() })));
}

let site = null;
test.beforeAll(async () => { site = await serveClient(); });
test.afterAll(() => site?.stop());

// Everything below runs in the page: the modules are the ones a worker loads.
async function inPage(page, fn, arg) {
    await page.goto(site.url);
    const has = await page.evaluate(() => Boolean(globalThis.navigator?.gpu));
    if (!has) test.skip(true, 'no WebGPU in this browser');
    return page.evaluate(fn, arg);
}

test('the shader and the reference renderer draw the same scene', async ({ page }) => {
    const out = await inPage(page, async (size) => {
        const { blobs, rng, ringCamera } = await import('/test/scene.js');
        const { render } = await import('/lib/gsrast.js');
        const { gpuDevice, gpuBackend } = await import('/lib/gsgpu.js');
        const { ratesFor } = await import('/lib/gstrain.js');
        const device = await gpuDevice();
        if (!device) return { skip: 'no adapter' };
        const model = blobs(140, rng(5));
        const cam = ringCamera(0.7, size);
        const cpu = render(cam, model.scene()).rgb;
        const backend = await gpuBackend(device, ratesFor(1),
            { width: size, height: size });
        backend.prepare([]);
        backend.load({ model });
        const gpu = (await backend.render(cam)).rgb;
        let worst = 0;
        let sum = 0;
        for (let i = 0; i < cpu.length; i++) {
            worst = Math.max(worst, Math.abs(cpu[i] - gpu[i]));
            sum += (cpu[i] - gpu[i]) ** 2;
        }
        const ink = cpu.reduce((s, v) => s + v, 0) / cpu.length;
        backend.dispose();
        return { worst, rms: Math.sqrt(sum / cpu.length), ink };
    }, SIZE);
    if (out.skip) test.skip(true, out.skip);
    expect(out.ink, 'the scene is not blank').toBeGreaterThan(0.05);
    expect(out.rms, `worst pixel ${out.worst}`).toBeLessThan(2e-3);
    expect(out.worst).toBeLessThan(0.05);
});

test('one step of Adam moves both backends to the same parameters',
    async ({ page }) => {
        const out = await inPage(page, async (size) => {
            const { blobs, rng, viewsOf } = await import('/test/scene.js');
            const { gpuDevice, gpuBackend } = await import('/lib/gsgpu.js');
            const { CpuBackend, ratesFor } = await import('/lib/gstrain.js');
            const device = await gpuDevice();
            if (!device) return { skip: 'no adapter' };
            const truth = blobs(140, rng(5));
            const views = viewsOf(truth, [0.7], size);
            const rates = ratesFor(2);
            const start = blobs(140, rng(31));
            const clone = start.select([...Array(start.count).keys()]);

            const cpu = new CpuBackend(rates);
            cpu.prepare(views);
            cpu.load({ model: start });
            await cpu.step(views[0], 1);

            const gpu = await gpuBackend(device, rates, { width: size, height: size });
            gpu.prepare(views);
            gpu.load({ model: clone });
            await gpu.step(views[0], 1);
            const after = (await gpu.save()).model;
            gpu.dispose();

            const off = {};
            for (const k of ['pos', 'logScale', 'quat', 'sh', 'logit']) {
                let moved = 0;
                let worst = 0;
                for (let i = 0; i < after[k].length; i++) {
                    moved = Math.max(moved, Math.abs(after[k][i] - clone[k][i]));
                    worst = Math.max(worst, Math.abs(after[k][i] - start[k][i]));
                }
                off[k] = { moved, worst };
            }
            return off;
        }, SIZE);
        if (out.skip) test.skip(true, out.skip);
        for (const [field, v] of Object.entries(out)) {
            expect(v.moved, `${field} did not move at all`).toBeGreaterThan(0);
            expect(v.worst, `${field}: the two backends differ by ${v.worst}`)
                .toBeLessThan(v.moved * 0.05);
        }
    });

test('a scene trains on the GPU towards views it was never shown',
    async ({ page }) => {
        const out = await inPage(page, async (size) => {
            const { blobs, rng, viewsOf } = await import('/test/scene.js');
            const { gpuDevice, gpuBackend } = await import('/lib/gsgpu.js');
            const { boundsOf, ratesFor, scoreOf, train } = await import('/lib/gstrain.js');
            const device = await gpuDevice();
            if (!device) return { skip: 'no adapter' };
            const truth = blobs(60, rng(3));
            const views = viewsOf(truth, [0, 0.9, 1.8, 2.7, 3.6, 4.5, 5.4], size);
            const held = viewsOf(truth, [1.3], size);
            const bounds = boundsOf(truth, 0.3);
            const model = blobs(60, rng(91));
            const backend = await gpuBackend(device, ratesFor(bounds.extent),
                { width: size, height: size });
            backend.prepare(views);
            backend.load({ model });
            const before = await scoreOf(backend, held);
            const started = Date.now();
            const done = await train(backend, model, {
                iters: 300, views, random: rng(5), bounds, budget: 200, grow: 0.1,
                maintainEvery: 100, noise: 0.05, logEvery: 100,
            });
            const after = await scoreOf(backend, held);
            backend.dispose();
            return { before, after, seconds: (Date.now() - started) / 1000,
                splats: done.model.count, loss: done.loss };
        }, SIZE);
        if (out.skip) test.skip(true, out.skip);
        expect(out.after[0], `${out.before[0]} dB -> ${out.after[0]} dB in ${out.seconds}s`)
            .toBeGreaterThan(out.before[0] + 2);
        expect(out.splats).toBeLessThanOrEqual(200);
    });
