// linespanel.js — what the Lines panel says about the selected line and does
// with it (EDT.17, EDT.18): Lay bed, Walk it, Reverse, Delete.
//
// Lay bed is the one place lines and ground meet (PLAN-editors D3): it opens
// Shape with Along line in hand and this line, its width, a shoulder and its
// kind's gradient filled in; Apply there lays the bed as one stroke.

import { el } from './tabbar.js';
import { NODE_DEEDS } from './lineedit.js';
import { curveOf } from './lines.js';
import { entryOf } from '../lib/kinds.js';
import { walkIt } from './linesdo.js';
import { profileOf } from './lineprofile.js';

export function mountSelected(host, ctx, state, say) {
    const title = el('div', { className: 'label ln-sel-title' });
    const act = (cls, words, fn) => {
        const b = el('button', { type: 'button', className: cls, textContent: words });
        b.onclick = fn;
        return b;
    };
    const node = el('div', { className: 'section ln-selected', hidden: true }, title,
        el('div', { className: 'sc-seg ln-deeds' },
            act('ln-bed primary', 'Lay bed', () => layBed(ctx, state, say)),
            act('ln-walk', 'Walk it · F', () => walkIt(ctx, state, say)),
            act('ln-reverse', 'Reverse', () => {
                if (state.selected) say(NODE_DEEDS.reverse(state, state.selected));
            }),
            act('ln-delete', 'Delete', () => {
                if (!state.selected) return;
                state.lines.remove(state.selected);
                state.selected = null;
                say('the line is gone — Save to keep it that way');
            })));
    host.append(node);
    return {
        draw() {
            node.hidden = !state.selected;
            if (state.selected) {
                const e = entryOf(state.entries, state.selected.kind, state.selected.props);
                title.textContent = e?.words ?? state.selected.kind;
            }
        },
    };
}

export function layBed(ctx, state, say) {
    const line = state.selected;
    if (!line) { say('select a line to lay its bed', true); return null; }
    const entry = entryOf(state.entries, line.kind, line.props);
    say('opening Shape with its bed');
    return ctx.layBed?.({ points: curveOf(line), width: Number(line.props?.width) || entry?.width,
        gradient: Math.min(30, entry?.gradient ?? 8), name: entry?.words ?? line.kind });
}

// ------------------------------------------------------------ the list

const pct = (v) => `${Math.round(v)} %`;

// One row of the list: its name, kind, length and steepest climb.
export function rowOf(line, entry, heightAt) {
    const p = profileOf(line, entry, heightAt);
    const len = p.samples.at(-1)?.at ?? 0;
    let steepest = 0;
    for (let i = 1; i < p.samples.length; i++) {
        const run = p.samples[i].at - p.samples[i - 1].at;
        if (run > 0) steepest = Math.max(steepest,
            Math.abs((p.samples[i].h - p.samples[i - 1].h) / run) * 100);
    }
    return { name: line.props?.name || entry?.words || line.kind, kind: entry?.words ?? line.kind,
        metres: len, steepest, over: p.over.length > 0 };
}

export function mountList(host, ctx, state, pick) {
    const list = el('ol', { className: 'ln-list' });
    host.append(el('div', { className: 'section' },
        el('div', { className: 'label', textContent: 'Lines on this land' }), list));
    let drawn = '';
    return {
        draw() {
            const live = state.lines?.live ?? [];
            const key = JSON.stringify(live.map((l) => [l.key, l.props, l.nodes.length, l.state,
                l === state.selected]));
            if (key === drawn) return;
            drawn = key;
            const heightAt = (lon, lat) => ctx.bp.heightAt(lon, lat);
            list.replaceChildren(...live.map((line) => {
                const r = rowOf(line, entryOf(state.entries, line.kind, line.props), heightAt);
                const li = el('li', { className: `ln-row${r.over ? ' over' : ''}` },
                    el('span', { className: 'ln-name', textContent: r.name }),
                    el('span', { className: 'muted', textContent: r.kind }),
                    el('span', { className: 'mono', textContent:
                        `${Math.round(r.metres)} m · ${pct(r.steepest)}` }));
                li.setAttribute('aria-selected', String(line === state.selected));
                li.onclick = () => pick(line);
                return li;
            }));
            if (!live.length) {
                list.append(el('li', { className: 'muted', textContent: 'none yet' }));
            }
        },
    };
}

// ---------------------------------------------------------- the fields

// The selected line's fields: a name, and its kind's own properties from the
// vocabulary, each as the form its type says (PLAN-editors idea 31).
export function mountFields(host, state, say) {
    const box = el('div', { className: 'ln-fields' });
    host.append(box);
    let drawn = null;
    const field = (p, line) => {
        const v = line.props?.[p.name];
        const input = p.type === 'choice'
            ? el('select', {}, new Option('—', ''), ...p.choices.map((c) => new Option(c, c)))
            : el('input', { type: p.type === 'number' ? 'number' : p.type === 'boolean'
                ? 'checkbox' : 'text' });
        if (p.type === 'boolean') input.checked = Boolean(v);
        else input.value = v ?? '';
        input.className = `ln-field ln-field-${p.name.replace(/[^a-z0-9]/g, '-')}`;
        input.onchange = () => {
            state.lines.remember();
            const raw = p.type === 'boolean' ? input.checked : input.value;
            const val = p.type === 'number' ? (raw === '' ? undefined : Number(raw)) : raw;
            line.props = { ...line.props, [p.name]: val === '' ? undefined : val };
            state.lines.changed(line);
            say(`${p.label || p.name} changed — Save to keep it`);
        };
        return el('label', {}, p.label || p.name, input);
    };
    return {
        draw() {
            const line = state.selected;
            if (line === drawn) return;
            drawn = line;
            if (!line) { box.replaceChildren(); return; }
            const own = (state.properties ?? []).filter((p) => p.kind === line.kind);
            box.replaceChildren(field({ name: 'name', label: 'Name', type: 'text' }, line),
                ...own.map((p) => field(p, line)));
        },
    };
}
