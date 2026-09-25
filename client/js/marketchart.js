// marketchart.js — the Marketplace's bar charts: one bar a day, as tall as the
// day's number, the tallest filling the box (TASKS-ui.md UI.5–6). Plain DOM:
// a chart of fourteen numbers needs no library.

import { el } from './poolui.js';

// `days` is [{ day, v }] oldest first (market.js byDay); `second`, when given,
// is a second series of the same days stacked on top in the second colour.
export function barChart(days, { second = null, label = (d) => d.day } = {}) {
    const total = (i) => days[i].v + (second?.[i]?.v ?? 0);
    const top = Math.max(1, ...days.map((_, i) => total(i)));
    const node = el('div', { className: 'mk-chart' });
    days.forEach((d, i) => {
        const bar = el('div', { className: 'mk-bar', title: `${label(d)} · ${total(i)}` },
            el('i', { className: 'b2', style: `height:${((second?.[i]?.v ?? 0) / top) * 100}%` }),
            el('i', { className: 'b1', style: `height:${(d.v / top) * 100}%` }));
        bar.dataset.v = String(total(i));
        node.append(bar);
    });
    return node;
}
