// plannerchart.js — under the Planner's lanes: how long each of one job's last
// runs took, one bar a run, oldest on the left.
//
// One measure, one axis. Every bar is coloured by how the run ended AND carries
// a second cue (plannerui.js: hatch for warnings, a cross for a failure), since
// "done" and "done with warnings" are too close for a colour-blind reader. The
// dashed line is the usual run (the median); hovering or focusing a bar says
// when it ran, how long it took and how it ended.

import { el } from './poolui.js';
import { STATUS_WORDS, tookWords } from './planner.js';

const LAST = 60;

const when = (t) => {
    const d = new Date(t);
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} `
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Three gridlines, at nice fractions of the slowest run.
function axis(top) {
    return [1, 0.5, 0].map((f) => {
        const line = el('div', { className: 'pl-grid' },
            el('span', { className: 'pl-grid-label mono', textContent: tookWords(top * f) }));
        line.style.bottom = `${f * 100}%`;
        return line;
    });
}

function bar(run, top, tip) {
    const b = el('button', { type: 'button', className: 'pl-bar' });
    b.dataset.status = run.status;
    b.style.height = `${Math.max(2, ((run.duration ?? 0) / top) * 100)}%`;
    const words = `${when(run.at)} · took ${tookWords(run.duration)} · ${STATUS_WORDS[run.status]}`;
    b.setAttribute('aria-label', words);
    const show = () => tip(b, words);
    b.onpointerenter = show;
    b.onfocus = show;
    return b;
}

export function mountChart(host) {
    const title = el('span', { className: 'pl-chart-title' });
    const numbers = el('span', { className: 'pl-chart-numbers mono' });
    const plot = el('div', { className: 'pl-plot' });
    const ends = el('div', { className: 'pl-chart-ends muted mono' });
    const tip = el('div', { className: 'pl-tip', hidden: true });
    const node = el('div', { className: 'pl-chart', hidden: true },
        el('div', { className: 'pl-chart-head' }, title, numbers), plot, ends, tip);
    host.append(node);
    const showTip = (b, words) => {
        tip.textContent = words;
        tip.hidden = false;
        const r = b.getBoundingClientRect();
        const h = node.getBoundingClientRect();
        tip.style.left = `${Math.min(r.left - h.left, h.width - 220)}px`;
        tip.style.top = `${r.top - h.top - 28}px`;
    };
    plot.onpointerleave = () => { tip.hidden = true; };

    return {
        node,
        show(row) {
            node.hidden = !row;
            if (!row) return;
            const runs = row.all.slice(-LAST);
            const top = Math.max(row.stats.slowest, 1) * 1.1;
            title.textContent = row.job.name;
            title.append(el('span', { className: 'muted',
                textContent: `  how long each run took · the last ${runs.length} runs` }));
            numbers.textContent = `usually ${tookWords(row.stats.usual)} · slowest `
                + `${tookWords(row.stats.slowest)} · failed ${row.stats.failed}`;
            const usual = el('div', { className: 'pl-usual' },
                el('span', { className: 'muted', textContent: 'usually' }));
            usual.style.bottom = `${(row.stats.usual / top) * 100}%`;
            const bars = el('div', { className: 'pl-bars' },
                ...runs.map((r) => bar(r, top, showTip)));
            plot.replaceChildren(...axis(top), bars, runs.length ? usual : '');
            ends.replaceChildren(el('span', { textContent: runs[0] ? when(runs[0].at) : '' }),
                el('span', { textContent: runs.at(-1) ? when(runs.at(-1).at) : '' }));
            if (!runs.length) {
                plot.append(el('p', { className: 'muted', textContent: 'It has not run yet.' }));
            }
        },
    };
}
