// groundtag.js — words on the ground, at the pointer (PLAN-editors.md §3 rule
// 3; EDT.4).
//
// Two things follow the pointer while Blueprint is open: a two-word tag that
// says what state the tool in hand is in ("not your land", "over limit",
// "snapped: road end"), and a small box of numbers — the ground there, what
// this stroke has done to it, how far it is off the elevation, and its slope.
// The panel's notes explain once; the tag explains every time.
//
// And Tab, held, is a peek: the splats and the models come back over the clay
// until it is let go of (idea 5). Tab is the apps drawer everywhere else, so
// while Blueprint is open it is taken before the drawer hears it.

import { el } from './tabbar.js';

const signed = (v, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}`
    + `${Math.abs(v).toFixed(digits)} m`;

/**
 * The numbers box's rows: [label, value, tone]. `at` is what is known under
 * the pointer: {ground, stroke, off, slope, limit: {up, down}, over}.
 */
export function numbersRows(at) {
    if (!at || !Number.isFinite(at.ground)) return [['ground', 'no ground', 'bad']];
    const rows = [['ground', `${at.ground.toFixed(1)} m`, '']];
    if (Number.isFinite(at.stroke)) rows.push(['this stroke', signed(at.stroke), 'acc']);
    rows.push(['off the elevation', signed(at.off ?? 0), at.over ? 'warn' : '']);
    if (Number.isFinite(at.slope)) rows.push(['slope', `${Math.round(at.slope)}°`, '']);
    if (at.limit) {
        rows.push(['limit', `+${at.limit.up} / −${at.limit.down} m`, at.over ? 'warn' : '']);
    }
    return rows;
}

/**
 * The tag, from what is under the pointer, most important first. `at` holds
 * {lost, inside, over, band, snapped, tool}; an empty string is no tag.
 */
export function tagFor(at) {
    if (!at || at.lost) return { text: 'no ground', tone: 'dim' };
    if (at.snapped) return { text: `snapped: ${at.snapped}`, tone: 'acc' };
    if (at.inside === false) return { text: 'not your land', tone: 'bad' };
    if (at.over) return { text: 'over limit', tone: 'warn' };
    if (at.follow) return { text: 'follow contour', tone: 'acc' };
    if (at.band) return { text: 'edge blend', tone: 'dim' };
    return { text: '', tone: '' };
}

// The two nodes, hung on the chrome and moved with the pointer.
export function mountGroundTag(host) {
    const tag = el('div', { className: 'bp-tag mono', hidden: true });
    const box = el('div', { className: 'bp-nums glass', hidden: true });
    host.append(tag, box);
    return {
        tag, box,
        show(x, y, { tag: t, rows }) {
            tag.hidden = !t?.text;
            tag.textContent = t?.text ?? '';
            tag.dataset.tone = t?.tone ?? '';
            tag.style.transform = `translate(${x + 18}px, ${y + 14}px)`;
            box.hidden = !rows?.length;
            box.replaceChildren(...(rows ?? []).map(([label, value, tone]) =>
                el('div', { className: 'bp-num-row' },
                    el('span', { className: 'muted', textContent: label }),
                    el('span', { className: `mono ${tone}`, textContent: value }))));
            box.style.transform = `translate(${x + 24}px, ${y - 110}px)`;
        },
        hide() { tag.hidden = true; box.hidden = true; },
    };
}

// Hold Tab to peek. Taken in the capture phase, before the apps drawer.
export function bindPeek(bp) {
    const down = (e) => {
        if (e.code !== 'Tab' || !bp.active) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!bp.peeking) bp.peek(true);
    };
    const up = (e) => {
        if (e.code !== 'Tab' || !bp.peeking) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        bp.peek(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
    };
}
