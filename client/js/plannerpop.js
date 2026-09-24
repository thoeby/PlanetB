// plannerpop.js — one run of the Planner, opened: when, how long, what started
// it, how it ended, and — for a failure — the first thing the report says went
// wrong; with Open report, Run now and Edit job.

import { el } from './poolui.js';
import { STATUS_WORDS, tookWords } from './planner.js';
import { recordsApi } from '../flow/server/records.js';

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

// The first line of a failed run's report that is not "nothing to do".
async function whatWentWrong(server, run) {
    try {
        const xml = await recordsApi(server.url).reportXml(run.id);
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const lines = [...doc.getElementsByTagName('line'),
            ...doc.getElementsByTagName('message')]
            .map((n) => (n.textContent ?? '').trim()).filter(Boolean);
        return lines[0] ?? '';
    } catch {
        return '';
    }
}

const pair = (k, v, tone = '') => {
    const val = el('span', { textContent: v });
    if (tone) val.dataset.tone = tone;
    return el('div', { className: 'pl-pair' },
        el('span', { className: 'muted', textContent: k }), val);
};

export function mountPopover(host, on) {
    const node = el('div', { className: 'pl-pop', hidden: true });
    host.append(node);
    const hide = () => { node.hidden = true; };
    return {
        hide,
        async show(row, run, anchor, server) {
            const badge = el('span', { className: 'pl-badge',
                textContent: STATUS_WORDS[run.status] });
            badge.dataset.status = run.status;
            const close = el('button', { type: 'button', className: 'pl-pop-close',
                textContent: '\u00d7' });
            close.setAttribute('aria-label', 'Close');
            close.onclick = hide;
            const why = el('div');
            const b = (text, cls, fn) => {
                const x = el('button', { type: 'button', className: cls, textContent: text });
                x.onclick = () => { hide(); fn(); };
                return x;
            };
            node.replaceChildren(
                el('div', { className: 'pl-pop-head' },
                    el('span', { textContent: row.job.name }),
                    el('span', { className: 'muted mono', textContent: hhmmss(run.at) }),
                    badge, close),
                pair('took', tookWords(run.duration)),
                pair('started by', run.startedBy ?? '—'),
                pair('ended', STATUS_WORDS[run.status], run.status === 'failed' ? 'bad' : 'good'),
                why,
                el('div', { className: 'pl-pop-acts' },
                    b('Open report', 'primary pl-open-report', () => on.report(row, run)),
                    b('Run now', 'pl-run-now', () => on.run(row)),
                    b('Edit job', 'pl-edit', () => on.edit(row))));
            const a = anchor.getBoundingClientRect();
            const h = host.getBoundingClientRect();
            node.style.left = `${Math.max(8, Math.min(a.left - h.left - 120, h.width - 260))}px`;
            node.style.top = `${a.bottom - h.top + 6}px`;
            node.hidden = false;
            if (run.status === 'failed') {
                const words = await whatWentWrong(server, run);
                if (words) why.replaceChildren(pair(`${server.name} said`, words, 'bad'));
            }
        },
    };
}
