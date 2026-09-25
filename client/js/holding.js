// holding.js — picking a thing up, carrying it, and putting it down (LV.4).
//
// A product that may be carried (`parts.carry`, db/0205) gets **Pick up** in
// the Place panel when it is selected; what you carry is listed under it with
// **Put down here**, which puts it on the ground a step in front of you. The
// world decides everything (`take`, `drop`, `give`, each a CAS on the holder)
// and says the refusals in words: "Anna has it."

import * as api from './api.js';
import { el } from './poolui.js';

const STEP_M = 1.5;

export const HTML = `
<div class="section build-hold-section">
  <span class="label">Carrying</span>
  <div class="build-take row"></div>
  <ul class="build-held rows"></ul>
  <p class="build-hold-said status"></p>
</div>`;

const words = (err) => String(err?.body?.message ?? err?.message ?? err);

// Where a step in front of the player is, on the ground, in lon/lat.
export function inFront({ camera, origin, terrain }) {
    const p = camera.getPosition();
    const f = camera.forward;
    const len = Math.hypot(f.x, f.z) || 1;
    const at = { x: p.x + (f.x / len) * STEP_M, y: p.y, z: p.z + (f.z / len) * STEP_M };
    at.y = terrain?.heightAt?.(at) ?? p.y;
    return origin.geodeticOf(at);
}

// What I carry, each with the button that puts it down.
function rows(held, drop) {
    if (!held.length) {
        return [el('li', { className: 'muted',
            textContent: 'Nothing. A thing that may be carried has Pick up when selected.' })];
    }
    return held.map((item) => {
        const b = el('button', { type: 'button', className: 'build-putdown',
            textContent: 'Put down here' });
        b.onclick = () => drop(item);
        const li = el('li', { className: 'build-held-item' },
            el('span', { textContent: item.name }), b);
        li.dataset.instance = item.instance;
        return li;
    });
}

export function mountHolding(host, ctx) {
    host.insertAdjacentHTML('beforeend', HTML);
    const q = (sel) => host.querySelector(sel);
    const said = q('.build-hold-said');
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
    };
    let held = [];

    const after = async (text) => {
        say(text);
        await refresh();
        await ctx.changed?.();
    };

    async function take(row, name) {
        try {
            await api.rpc('take', { p_instance: row.id });
            await after(`You have ${name}.`);
        } catch (err) {
            say(words(err), true);
        }
    }

    async function drop(item) {
        const g = inFront(ctx);
        try {
            await api.rpc('drop', { p_instance: item.instance, p_lon: g.lon, p_lat: g.lat,
                p_h: g.h ?? 0 });
            await after(`You put ${item.name} down.`);
        } catch (err) {
            say(words(err), true);
        }
    }

    // The selected thing, when it is one that may be carried.
    function show(row, asset) {
        const box = q('.build-take');
        if (!row || !asset?.parts?.carry) { box.replaceChildren(); return; }
        const name = asset.name ?? row.san;
        const b = el('button', { type: 'button', className: 'build-pickup',
            textContent: `Pick up ${name}` });
        b.onclick = () => take(row, name);
        box.replaceChildren(b);
    }

    async function refresh() {
        held = await api.rpc('my_holdings').catch(() => []);
        q('.build-held').replaceChildren(...rows(held, drop));
        return held;
    }

    return { show, refresh, held: () => held, say };
}
