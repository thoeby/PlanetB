// modelpreview.js — the model in the Register form, as it will look when a
// player meets it, with its live parts doing what they are told.
//
// FND.6: a lamp's head lights up, a billboard's screen shows something. The
// catalog's thumbnail is one fixed picture (client/lib/thumb.js) and stays
// that; this is the same shading, drawn again whenever the maker flips a port,
// so what the ports do can be seen before the thing is registered.
//
// The compiler bakes neither of those two (client/atoms/assemble.js), which is
// why they are drawn here rather than read out of the picture.

import { perspective, viewMatrix } from '../lib/cameras.js';
import { meshesOf } from '../lib/glbmesh.js';
import { Renderer } from '../lib/render.js';
import { thumbCamera } from '../lib/thumb.js';

const SIZE = 256;

const OFF = 0.22;                              // a lamp that is not lit
const HIGHLIGHT = [1, 0.45, 0.15];             // the node being marked

const hex = (value) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value ?? ''));
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 0.85, 0.63];
};

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

const mix = (a, b, k = 0.5) => a.map((v, i) => v * (1 - k) + b[i] * k);

// What a light looks like right now: its colour when it is on, and nearly
// black when it is not. A lamp nobody has switched on is a lamp that is off.
function lightTint(mark, values) {
    const on = truthy(said(mark, values, 'light'));
    const colour = hex(said(mark, values, 'colour') ?? mark.colour);
    return on ? colour : colour.map((c) => c * OFF);
}

// What the port driving this part in this way is set to — what the maker has
// just flipped, or what the port starts out as.
function said(mark, values, what) {
    const port = mark.ports.find((p) => p.drives?.what === what);
    if (!port) return undefined;
    return values[port.name] ?? port.default;
}

// The markings, in the shape this file wants: each part's mark, with the ports
// that drive it, by part name.
function marksByPart(marks) {
    const out = new Map();
    for (const p of marks?.parts ?? []) {
        out.set(p.name, { ...p,
            ports: (marks.ports ?? []).filter((q) => q.drives?.part === p.name) });
    }
    return out;
}

// One WebGL context per form, not one per redraw: a context is a scarce thing
// and a maker flips a port a dozen times.
export class ModelPreview {
    constructor(make = (w, h) => new OffscreenCanvas(w, h)) {
        this.make = make;
        this.renderer = null;
    }

    fresh() {
        this.renderer?.dispose();
        this.renderer = new Renderer(this.make(SIZE, SIZE), SIZE);
        return this.renderer;
    }

    // `values` is port name -> what it is set to; `highlight` is the part
    // whose node the maker is looking at.
    draw(canvas, glb, { marks = null, values = {}, highlight = null } = {}) {
        const by = marksByPart(marks);
        const meshes = meshesOf(glb).map((m) => {
            const mark = m.part ? by.get(m.part) : null;
            const live = mark?.role === 'light' ? lightTint(mark, values) : null;
            // The node being marked is picked out in orange, but only half so:
            // a light that is off and one that is on must still look different
            // while the maker is looking at it.
            const colour = m.part === highlight
                ? mix(live ?? [m.colors[0], m.colors[1], m.colors[2]], HIGHLIGHT)
                : live;
            if (!colour) return m;
            const colors = new Float32Array(m.colors.length);
            for (let i = 0; i < colors.length; i += 3) colors.set(colour, i);
            return { ...m, colors };
        });
        const cam = thumbCamera(meshes);
        const renderer = this.fresh();
        renderer.upload(meshes);
        const rgba = renderer.draw(cam, { near: cam.near, far: cam.far });
        const ctx = canvas.getContext('2d');
        const img = new ImageData(new Uint8ClampedArray(rgba), SIZE, SIZE);
        const tmp = this.make(SIZE, SIZE);
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
        for (const [name, mark] of by) {
            if (mark.role === 'screen') screenOn(ctx, canvas, meshes, name, cam);
        }
    }
}

// Where a part lands on the picture: its box through the same camera, which
// is enough for a rectangle and is what a screen is.
function boxOnScreen(meshes, part, cam, size) {
    const v = viewMatrix(cam);
    const p = perspective(cam.fov, 1, cam.near, cam.far);
    let lo = [Infinity, Infinity]; let hi = [-Infinity, -Infinity];
    for (const m of meshes.filter((q) => q.part === part)) {
        for (let i = 0; i < m.positions.length; i += 3) {
            const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
            const cz = v[2] * x + v[6] * y + v[10] * z + v[14];
            if (cz > -cam.near) continue;
            const w = -cz;
            const sx = ((v[0] * x + v[4] * y + v[8] * z + v[12]) * p[0] / w + 1) * 0.5 * size;
            const sy = (1 - (v[1] * x + v[5] * y + v[9] * z + v[13]) * p[5] / w) * 0.5 * size;
            lo = [Math.min(lo[0], sx), Math.min(lo[1], sy)];
            hi = [Math.max(hi[0], sx), Math.max(hi[1], sy)];
        }
    }
    return Number.isFinite(lo[0]) ? { lo, hi } : null;
}

// The placeholder: nothing has been put on this screen yet, and this is what
// a screen with nothing on it shows.
function screenOn(ctx, canvas, meshes, part, cam) {
    const box = boxOnScreen(meshes, part, cam, SIZE);
    if (!box) return;
    const k = canvas.width / SIZE;
    const [x, y] = [box.lo[0] * k, box.lo[1] * k];
    const [w, h] = [(box.hi[0] - box.lo[0]) * k, (box.hi[1] - box.lo[1]) * k];
    const step = Math.max(4, Math.round(Math.min(w, h) / 4));
    for (let j = 0; j * step < h; j++) {
        for (let i = 0; i * step < w; i++) {
            ctx.fillStyle = (i + j) % 2 ? '#d8d8d8' : '#3a3a3a';
            ctx.fillRect(x + i * step, y + j * step,
                Math.min(step, w - i * step), Math.min(step, h - j * step));
        }
    }
}
