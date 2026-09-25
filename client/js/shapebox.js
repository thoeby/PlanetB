// shapebox.js — the box under Shape's rail: the numbers the brush in hand
// reads, the falloff curve drawn live with its four presets, and the brush's
// shape (EDT.7, docs/design/splatworld-v11.dc.html 11a).
//
// Nodes and state only; what the numbers do is client/js/sculptbrush.js.

import { falloffAt } from './sculptbrush.js';
import { brushLine } from './sculptmode.js';

// The curve as the box draws it: the brush's profile from edge to edge.
export function curvePath(soft, curve, steps = 50) {
    const pts = [];
    for (let s = 0; s <= steps; s++) {
        const x = s / steps;
        const k = falloffAt(Math.abs(2 * x - 1), { soft, curve });
        pts.push(`${(x * 100).toFixed(1)} ${(28 - 26 * k).toFixed(1)}`);
    }
    return `M${pts.join(' L')}`;
}

/**
 * Wires the box's fields to `state` {size, strength, soft, curve, shape}.
 * `q` finds a node in the panel; `said()` is told whenever a number changed.
 */
export function wireBox(q, all, state, said) {
    const redraw = () => {
        q('.sc-curve path').setAttribute('d', curvePath(state.soft, state.curve));
        for (const b of all('.sc-curves button')) {
            b.setAttribute('aria-pressed', String(b.dataset.curve === state.curve));
        }
        for (const b of all('.sc-shapes button')) {
            b.setAttribute('aria-pressed', String(b.dataset.shape === state.shape));
        }
        q('.sc-brush-says').textContent = brushLine(state);
        said();
    };
    const resize = (metres) => {
        state.size = Math.min(200, Math.max(1, Math.round(metres) || 12));
        q('.sc-size').value = String(state.size);
        redraw();
    };
    q('.sc-size').addEventListener('change', (e) => resize(Number(e.target.value)));
    q('.sc-strength').addEventListener('change', (e) => {
        state.strength = Math.min(20, Math.max(0.05, Number(e.target.value) || 1));
        redraw();
    });
    q('.sc-soft').addEventListener('change', (e) => {
        const v = Number(e.target.value);
        state.soft = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
        redraw();
    });
    for (const b of all('.sc-curves button')) {
        b.onclick = () => { state.curve = b.dataset.curve; redraw(); };
    }
    for (const b of all('.sc-shapes button')) {
        b.onclick = () => { state.shape = b.dataset.shape; redraw(); };
    }
    q('.sc-fall').addEventListener('change', (e) => {
        state.fall = Math.min(5, Math.max(0, Number(e.target.value) || 0));
        redraw();
    });
    const turn = (deg) => {
        state.dir = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
        q('.sc-dir').value = String(state.dir);
    };
    q('.sc-dir').addEventListener('change', (e) => { turn(e.target.value); redraw(); });
    // Level's height: typed, taken off the ground, or the floor of a thing.
    const aim = (h) => {
        state.target = Number(h);
        if (Number.isFinite(state.target)) q('.sc-target').value = state.target.toFixed(1);
    };
    q('.sc-target').addEventListener('change', (e) => aim(e.target.value));
    q('.sc-floor').addEventListener('change', (e) => { if (e.target.value) aim(e.target.value); });
    q('.sc-strength').value = String(state.strength);
    q('.sc-soft').value = String(state.soft);
    redraw();
    return { resize, redraw, turn, aim };
}

// The things standing on this land, as "floor of …" choices for Level.
export function floors(select, things) {
    select.replaceChildren(new Option('floor of…', ''),
        ...(things ?? []).filter((t) => Number.isFinite(Number(t.h))).map((t) =>
            new Option(`${t.name ?? t.san} · ${Number(t.h).toFixed(1)} m`, String(t.h))));
}
