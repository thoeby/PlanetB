// bpmode.js — Blueprint as a mode of the world view (PLAN-editors.md §2.1):
// the clay, its camera, the words at the pointer, Tab's peek and the section
// line, opened by a surface (Shape, Lines) and closed with it.
//
// A surface hands in what only it knows — which tool is in hand, what a
// press, a drag and a release do with it, what to say about the ground under
// the pointer, and what to draw every frame. Two tools are the mode's own
// and the same on every surface: the hand (H) and the section (C).

import { BlueprintCamera } from './bpcamera.js';
import { pickGround } from './blueprint.js';
import { drawMark, drawPath } from './bpdraw.js';
import { bindPeek, mountGroundTag, numbersRows, tagFor } from './groundtag.js';
import { mountProfileStrip } from './profilestrip.js';
import { mountBlueprintSide } from './bpside.js';
import { indexOf, slopeAt } from '../lib/bpgrid.js';
import { nearestSample, sampleAlong } from '../lib/profile.js';

// How near the section line the pointer has to be for the strip to follow it.
const SYNC_M = 12;

export function mountBlueprintMode(ctx) {
    const { bp, app, pc } = ctx;
    const host = ctx.host ?? document.getElementById('hud') ?? document.body;
    const cam = new BlueprintCamera(bp, ctx);
    // A right click on the clay is the surface's to answer.
    ctx.onContext = (e) => st.surface?.context?.(pick(e), e);
    const words = mountGroundTag(host);
    const strip = mountProfileStrip(host);
    const side = mountBlueprintSide(host, { bp, cam });
    const st = { surface: null, at: null, lost: false, down: null, section: null,
        marked: null, unpeek: null, screen: null };
    strip.onHover((s) => { st.marked = s; });

    const pick = (e) => {
        const r = ctx.canvas.getBoundingClientRect();
        return pickGround(bp, ctx.camera, e.clientX - r.left, e.clientY - r.top);
    };
    const tool = () => st.surface?.tool?.() ?? 'pan';
    const handlers = pointerHandlers(ctx, { bp, cam, st, strip, pick, tool, say, words });

    // What is under the pointer, for the tag and the numbers.
    function say(e) {
        const g = st.at;
        const base = describe(bp, g, st.lost);
        const more = st.surface?.describe?.(g, base) ?? base;
        st.screen = e ? { x: e.clientX, y: e.clientY } : st.screen;
        if (!st.screen) return;
        words.show(st.screen.x, st.screen.y,
            { tag: tagFor({ ...more, tool: tool() }), rows: numbersRows(more) });
    }

    return {
        cam, strip, words, side,
        get active() { return bp.active; },
        get surface() { return st.surface; },
        state: st,
        async open(area, shaping, surface) {
            // Another surface had the clay (Shape, then Lines): it goes first.
            if (bp.active) this.close();
            // The walk camera lets go before the ground has loaded (bpcamera hold).
            cam.hold();
            st.surface = surface;
            const ms = await bp.open(area, shaping);
            cam.enter();
            for (const [name, fn, opts] of handlers) ctx.canvas.addEventListener(name, fn, opts);
            st.unpeek = bindPeek(bp);
            return ms;
        },
        close() {
            if (!bp.active) return;
            for (const [name, fn] of handlers) ctx.canvas.removeEventListener(name, fn);
            st.unpeek?.();
            cam.leave();
            bp.close();
            strip.hide();
            words.hide();
            st.section = null;
            st.surface = null;
        },
        // Every frame, from the page's update.
        frame: (dt = 1 / 60) => drawFrame(bp, app, pc, cam, st, dt),
        say,
    };
}

function drawFrame(bp, app, pc, cam, st, dt) {
    if (!bp.active) return;
    cam.update(dt);
    st.surface?.tick?.(dt);
    if (st.section?.b) {
        drawPath(bp, app, pc, [st.section.a, st.section.b], new pc.Color(1, 0.8, 0.3));
    }
    if (st.marked) drawMark(bp, app, pc, st.marked, new pc.Color(1, 0.75, 0.25), 3);
    st.surface?.draw?.();
}

// What the mode knows about a point on the clay by itself.
export function describe(bp, g, lost) {
    if (!g || lost) return { lost: true };
    const s = bp.shaping;
    const { i, j } = bp.L ? indexOf(bp.L, g.lon, g.lat) : { i: -1, j: -1 };
    const on = bp.L && i >= 0 && j >= 0 && i < bp.L.cols && j < bp.L.rows;
    return {
        ground: bp.heightAt(g.lon, g.lat),
        off: s?.at(g.lon, g.lat) ?? 0,
        slope: on ? slopeAt(bp.L, bp.heights, Math.round(i), Math.round(j)) : null,
        inside: s ? s.inside(g.lon, g.lat) : null,
    };
}

function pointerHandlers(ctx, { bp, cam, st, strip, pick, tool, say, words }) {
    const move = (e) => {
        const g = pick(e);
        st.lost = !g;
        if (g) st.at = g;
        if (st.down === 'pan') cam.drag(e);
        else if (st.down === 'section' && g) st.section.b = g;
        else if (st.down === 'tool') st.surface?.move?.(g, e);
        else {
            st.surface?.hover?.(g, e);
            if (g && strip.samples.length && st.section) {
                const n = nearestSample(strip.samples, g.lon, g.lat);
                strip.mark(n && n.d < SYNC_M ? n.sample : null);
                st.marked = n && n.d < SYNC_M ? n.sample : null;
            }
        }
        say(e);
    };
    const up = (e) => {
        if (st.down === 'section' && st.section?.b) {
            const samples = sampleAlong([st.section.a, st.section.b],
                (lon, lat) => bp.heightAt(lon, lat), 1);
            if (samples.at(-1).at > 1) strip.show(samples, { name: 'Section' });
        }
        if (st.down === 'tool') st.surface?.up?.(pick(e), e);
        if (st.down === 'pan') cam.drop();
        st.down = null;
        say(e);
    };
    return [
        ['pointerdown', (e) => {
            if (e.button !== 0) return;
            const t = tool();
            if (t === 'pan') { st.down = cam.grab(e) ? 'pan' : null; return; }
            const g = pick(e);
            if (t === 'section') {
                if (g) { st.section = { a: g, b: null }; st.down = 'section'; }
                return;
            }
            st.down = 'tool';
            st.surface?.down?.(g, e);
        }],
        ['pointermove', move],
        ['pointerup', up],
        // Off the clay (onto a panel, the strip): the words at the pointer go.
        ['pointerleave', (e) => { if (st.down) up(e); st.lost = true; words.hide(); }],
    ];
}
