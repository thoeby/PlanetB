// linesdo.js — the Lines surface's helpers (EDT.15-16): what is said about
// the selected line, its profile in the strip, Walk it, and the keys. The
// panel is client/js/linesui.js.

import { entryOf } from '../lib/kinds.js';
import { profileOf } from './lineprofile.js';
import { curveOf } from './lines.js';
import { dropLast } from './linetool.js';
import { LINE_TOOLS } from './linetools.js';

// The selected line's profile in the strip (EDT.16): red past its kind's
// gradient, ticks where it is too steep across; a click on it goes there.
export function showProfile(ctx, state) {
    const strip = ctx.bpmode.strip;
    const line = state.selected;
    const key = line ? `${line.key}:${JSON.stringify(line.nodes)}` : null;
    if (key === state.profiled) return;
    state.profiled = key;
    if (!line || line.nodes.length < 2) { strip.hide(); return; }
    const entry = entryOf(state.entries, line.kind, line.props);
    const p = profileOf(line, entry, (lon, lat) => ctx.bp.heightAt(lon, lat));
    strip.show(p.samples, { name: entry?.words ?? line.kind, max: p.max, marks: p.marks });
    strip.onGo((s) => {
        const cam = ctx.bpmode.cam;
        cam.state.target = { lon: s.lon, lat: s.lat, h: s.h ?? cam.state.target.h };
        cam.update();
    });
}

// Walk it (F): along the selected line at eye height, Esc to come back.
export function walkIt(ctx, state, say) {
    if (!state.selected) { say('select a line to walk it', true); return; }
    ctx.bpmode.cam.walk(curveOf(state.selected));
    say('walking it \u2014 Esc to come back');
}

// Undo puts back copies of the lines, so the selection follows its key.
export function reselect(state) {
    const key = state.selected?.key;
    state.selected = key ? state.lines?.live.find((l) => l.key === key) ?? null : null;
    if (!state.selected) state.node = null;
}

// What the selected line is, in a line.
export function describeSelected(state) {
    const l = state.selected;
    if (!l) return 'nothing selected — click a line';
    const n = state.node;
    return `${l.kind}${l.props?.[l.kind] ? ` \u00b7 ${l.props[l.kind]}` : ''}, ${l.nodes.length}`
        + ` nodes${Number.isInteger(n) ? ` \u00b7 node ${n + 1} in hand` : ''}`;
}

// The rail's keys, the kinds on 1–9, Enter and Esc while a line is being
// drawn. Esc is taken before the chrome hears it, which would close the panel.
export function bindKeys(ctx, state, acts, picker, pick) {
    window.addEventListener('keydown', (e) => {
        if (!state.on) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            (e.shiftKey ? acts.redo : acts.undo)();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Enter' && state.drawing) { e.preventDefault(); acts.finish(); return; }
        if (e.key === 'Escape' && ctx.bpmode.cam.walking) {
            e.preventDefault();
            e.stopImmediatePropagation();
            ctx.bpmode.cam.stopWalking();
            acts.say('back over the land');
            return;
        }
        if (e.key.toLowerCase() === 'f' && state.selected) {
            e.preventDefault();
            walkIt(ctx, state, acts.say);
            return;
        }
        if (e.key === 'Escape' && state.drawing) {
            e.preventDefault();
            e.stopImmediatePropagation();
            dropLast(state, acts.say);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && acts.deleteNode?.()) {
            e.preventDefault();
            return;
        }
        const tool = LINE_TOOLS.find((t) => t.key === e.key.toLowerCase());
        if (tool) { e.preventDefault(); pick(tool.id); return; }
        // 1–9 are the kinds while Lines is open, not the plinth's surfaces.
        if (/^[1-9]$/.test(e.key)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            picker.key(Number(e.key));
        }
    }, true);
}
