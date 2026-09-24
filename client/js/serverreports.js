// serverreports.js — a server's reports, and what a run said (TASKS-flows.md
// FL.5, docs/design/flows-servers.md §3d–3e).
//
// A report is the XML a process server kept of one run. It is shown as a tree
// you can fold, the way the reference editor shows it (src/reports/xmltree.js),
// in the panel under the canvas. That panel is also where Run now answers: a
// server that streams its runs over WS /job/run would be read there; one that
// does not — every one this page has met — is said to, and its report shown.

import { el } from './poolui.js';
import { ask } from './flowlist.js';
import { recordsApi } from '../flow/server/records.js';
import { failWords } from '../flow/server/client.js';
import { section, act } from './servertab.js';

// One element as a foldable branch: its tag and attributes, its text if that
// is all it holds, and its children below.
function branch(node) {
    const attrs = [...node.attributes].map((a) => `${a.name}="${a.value}"`).join(' ');
    const head = `${node.localName}${attrs ? ` ${attrs}` : ''}`;
    const kids = [...node.children];
    if (!kids.length) {
        return el('div', { className: 'fl-leaf' },
            el('span', { className: 'mono', textContent: head }), ' ',
            el('span', { textContent: (node.textContent ?? '').trim() }));
    }
    return el('details', { open: true }, el('summary', { className: 'mono', textContent: head }),
        ...kids.map(branch));
}

export function xmlTree(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror')[0] || !doc.documentElement) {
        return el('pre', { className: 'mono', textContent: xml });
    }
    return el('div', { className: 'fl-tree' }, branch(doc.documentElement));
}

const result = (r) => (r.ok === undefined ? '?' : r.ok ? '✓ 0' : `✕ ${r.code}`);

// The panel under the canvas: one run's or one report's header, and its tree.
export function mountRunPanel(host) {
    const title = el('span', { className: 'fl-run-title' });
    const state = el('span', { className: 'fl-run-state mono' });
    const note = el('p', { className: 'muted fl-run-note' });
    const body = el('div', { className: 'fl-run-body' });
    const close = el('button', { type: 'button', textContent: 'Close' });
    const node = el('div', { className: 'fl-run', hidden: true },
        el('div', { className: 'fl-run-head' }, title, state, close), note, body);
    close.onclick = () => { node.hidden = true; };
    host.append(node);
    return {
        node,
        async show(server, summary, words = '') {
            node.hidden = false;
            title.textContent = `${summary.jobName || 'a run'} on ${server.name}`;
            state.textContent = summary.ok === undefined ? 'running' : summary.ok ? 'done'
                : `failed · ${summary.code}`;
            note.textContent = words;
            body.replaceChildren();
            try {
                body.append(xmlTree(await recordsApi(server.url).reportXml(summary.id)));
            } catch (e) {
                body.append(el('p', { className: 'fl-err',
                    textContent: failWords(e, server.name) }));
            }
        },
    };
}

function line(r, bag, reload) {
    const s = bag.server();
    const li = el('li', { className: 'fl-remote' },
        el('span', { className: 'mono', textContent: (r.timestamp ?? '').replace('T', ' ') }),
        el('span', { className: 'pick', textContent: r.jobName || r.jobId || 'ad hoc' }),
        el('span', { className: 'fl-result', textContent: result(r) }));
    li.dataset.report = r.id;
    li.append(
        act('Open', 'open', () => bag.runPanel.show(s, r)),
        act('Del', 'del', () => ask(bag.dialogs(), {
            title: `Delete this report of ${r.jobName || 'a run'} on ${s.name}?`,
            value: r.jobName || '', ok: 'Delete',
            onOk: () => recordsApi(s.url).deleteReport(r.id).then(reload),
        })));
    return li;
}

export function mountReports(host, bag) {
    const which = el('select', { className: 'fl-report-job' });
    which.setAttribute('aria-label', 'Reports of job');
    which.onchange = () => part.run();
    const part = section(host, 'Reports', {
        head: [which],
        async load() {
            const api = recordsApi(bag.server().url);
            const jobs = await api.jobs().catch(() => []);
            const was = which.value;
            which.replaceChildren(el('option', { value: '', textContent: 'all jobs' }),
                ...jobs.map((j) => el('option', { value: j.id, textContent: j.name })));
            which.value = jobs.some((j) => j.id === was) ? was : '';
            return api.reports(which.value || undefined)
                .catch((e) => { throw new Error(failWords(e, bag.server().name)); });
        },
        draw(rows, list) {
            if (!list.length) {
                rows.append(el('li', { className: 'muted', textContent: 'No reports.' }));
            }
            for (const r of [...list].reverse()) rows.append(line(r, bag, () => part.run()));
        },
    });
    return part;
}
