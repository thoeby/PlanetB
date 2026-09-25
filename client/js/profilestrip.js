// profilestrip.js — a drawer along the bottom of the world: the ground's
// height along a line and its slope, stretches over a gradient in red
// (PLAN-editors.md ideas 6 and 21; EDT.5, reused by EDT.16).
//
// Hovering the strip marks the point on the ground and hovering the ground
// near the line marks the strip (`mark`); both ends go through the caller.
// A drawer, not a mode: nothing is turned off to look at it.

import { overGradient, sampleAt, slopes } from '../lib/profile.js';
import { el } from './tabbar.js';

const W = 1100;
const H = 110;
const PAD = 6;

export function mountProfileStrip(host) {
    const title = el('span', { className: 'caps ps-title' });
    const says = el('span', { className: 'mono muted ps-says' });
    const shut = el('button', { type: 'button', className: 'ps-close', textContent: '×',
        title: 'Close the strip' });
    const canvas = el('canvas', { className: 'ps-canvas', width: W, height: H });
    const node = el('div', { id: 'profile-strip', className: 'glass', hidden: true },
        el('div', { className: 'spread ps-head' }, title, el('span', {}, says, shut)), canvas);
    host.append(node);
    const state = { samples: [], max: null, marked: null, hover: null, go: null };

    const x = (at) => PAD + (at / Math.max(1, state.samples.at(-1)?.at ?? 1)) * (W - 2 * PAD);
    const atOf = (px) => (px - PAD) / (W - 2 * PAD) * (state.samples.at(-1)?.at ?? 0);
    const draw = () => paint(canvas, state, x);

    canvas.addEventListener('pointermove', (e) => {
        if (!state.samples.length) return;
        const r = canvas.getBoundingClientRect();
        const s = sampleAt(state.samples, atOf((e.clientX - r.left) * (W / r.width)));
        state.marked = s;
        draw();
        state.hover?.(s);
    });
    canvas.addEventListener('pointerleave', () => {
        state.marked = null;
        draw();
        state.hover?.(null);
    });
    canvas.addEventListener('click', () => { if (state.marked) state.go?.(state.marked); });
    shut.onclick = () => api.hide();

    const api = {
        node,
        get samples() { return state.samples; },
        get marked() { return state.marked; },
        // `max`: the gradient over which a stretch is red, or null for none.
        show(samples, { name = 'Section', max = null } = {}) {
            state.samples = samples;
            state.max = max;
            state.marked = null;
            const len = samples.at(-1)?.at ?? 0;
            const over = max ? overGradient(samples, max) : [];
            title.textContent = `${name} · ${Math.round(len)} m`;
            says.textContent = stripWords(samples, max, over);
            node.hidden = false;
            draw();
            return over;
        },
        hide() { node.hidden = true; state.samples = []; state.hover?.(null); },
        // The ground's end of the sync: a point near the line, or null.
        mark(sample) { state.marked = sample; if (!node.hidden) draw(); },
        onHover(fn) { state.hover = fn; },
        onGo(fn) { state.go = fn; },
    };
    return api;
}

// What the strip says in words beside its title.
export function stripWords(samples, max, over) {
    const s = slopes(samples).map(Math.abs);
    const steepest = s.length ? Math.max(...s) : 0;
    const bits = [`steepest ${steepest.toFixed(1)} %`];
    if (max) {
        bits.push(`max ${max} %`);
        bits.push(over.length ? `${over.length} stretch${over.length === 1 ? '' : 'es'} over`
            : 'none over');
    }
    return bits.join(' · ');
}

function paint(canvas, state, x) {
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    const hs = state.samples.map((s) => s.h).filter((h) => h !== null);
    if (hs.length < 2) return;
    const lo = Math.min(...hs);
    const hi = Math.max(...hs, lo + 1);
    const y = (h) => H - PAD - (h - lo) / (hi - lo) * (H - 2 * PAD);
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(242,239,232,0.9)';
    g.beginPath();
    state.samples.forEach((s, i) => (i ? g.lineTo : g.moveTo).call(g, x(s.at), y(s.h ?? lo)));
    g.stroke();
    if (state.max) {
        g.lineWidth = 4;
        g.strokeStyle = 'rgb(222,84,60)';
        for (const run of overGradient(state.samples, state.max)) {
            g.beginPath();
            for (const s of state.samples.filter((q) => q.at >= run.from && q.at <= run.to)) {
                g.lineTo(x(s.at), y(s.h ?? lo));
            }
            g.stroke();
        }
    }
    if (state.marked) {
        g.fillStyle = 'rgb(240,190,70)';
        g.fillRect(x(state.marked.at) - 1, 0, 2, H);
    }
}
