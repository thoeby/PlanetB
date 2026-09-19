// flowcheck.js — "would this flow run?", asked twice.
//
// SPEC §2.16 Validate. The process server is the authority: it is what will
// actually run the flow, and the page asks it by POSTing the ELX. But a world
// need not have one configured, and one that is configured need not answer, so
// the page always also checks what it can see for itself — one source per net,
// every wired pair allowed by the ports' own rule, and names unique in their
// scope. Both results are shown, and neither hides the other.

import * as api from './api.js';
import { parseEnvelope, ApiError } from '../flow/validate.js';
import { classifyNets, buildScopeIndex, basePortName } from '../flow/elx/nets.js';
import { getBlock } from '../flow/plugins/registry.js';
import { isValidConnection } from '../flow/graph/register.js';

export const ELX_URL = 'elx_url';

// Where flows are checked, as the operator set it (db/0156). Empty when
// nobody has.
export const checkingServer = () => api.rpc('app_settings')
    .then((s) => (s?.[ELX_URL] ?? '').trim())
    .catch(() => '');

export const setCheckingServer = (url) =>
    api.rpc('set_app_setting', { key: ELX_URL, value: url });

// ------------------------------------------------------------------ locally

// A port's definition, whichever kind of thing it is on: a block's declared
// port, or a pseudo-node's single one, which carries anything.
function portOf(conn, idx) {
    if (idx.pseudo.get(conn.node)) return undefined;
    const node = idx.nodes.get(conn.node);
    if (!node) return undefined;
    const block = getBlock(node.plugin, node.id);
    if (!block) return undefined;
    const want = basePortName(conn.port);
    return block.inputs.find((p) => p.name === want)
        ?? block.outputs.find((p) => p.name === want);
}

// Every problem one scope of a flow has, in the words the panel shows. `where`
// is the scope's name, so a problem inside a filter says which one.
function scopeProblems(flow, where) {
    const out = [];
    const at = (block, words) => out.push({ block, where, words });
    const seen = new Set();
    for (const n of [...flow.nodes, ...flow.subflows, ...flow.inputs, ...flow.outputs]) {
        if (seen.has(n.name)) at(n.name, `${n.name} is used twice in this flow`);
        seen.add(n.name);
    }
    const idx = buildScopeIndex(flow);
    for (const net of classifyNets(flow, getBlock)) {
        if (!net.source) {
            at(net.sinks[0]?.node ?? '', `nothing feeds ${net.sinks.length
                ? `${net.sinks[0].node}.${net.sinks[0].port}` : net.name}`);
            continue;
        }
        const from = portOf(net.source, idx);
        for (const sink of net.sinks) {
            const to = portOf(sink, idx);
            if (from && to && !isValidConnection(from, to)) {
                at(sink.node, `${net.source.node}.${net.source.port} cannot feed`
                    + ` ${sink.node}.${sink.port}`);
            }
        }
    }
    return out;
}

// The whole flow, its subflows included.
export function localProblems(flow, where = '') {
    return [...scopeProblems(flow, where),
        ...flow.subflows.flatMap((s) =>
            localProblems(s.body, where ? `${where} › ${s.name}` : s.name))];
}

// ------------------------------------------------------------------ the server

// Ask the process server. Returns what to say and whether it said yes; never
// throws, because "the server did not answer" is an answer the panel shows.
export async function askServer(url, elx, origin) {
    if (!url) {
        return { asked: false,
            words: 'No process server is configured for checking flows'
                + ' (Settings → Setup).' };
    }
    let res;
    try {
        res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/process/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
            body: elx,
        });
    } catch (err) {
        return { asked: false, words: said(err?.message ?? err, origin) };
    }
    const text = await res.text().catch(() => '');
    if (!res.ok && !text) {
        return { asked: false, words: said(`HTTP ${res.status}`, origin) };
    }
    try {
        parseEnvelope(text);
        return { asked: true, ok: true, words: 'valid' };
    } catch (err) {
        if (err instanceof ApiError && err.errorCode != null) {
            return { asked: true, ok: false, words: String(err.body || err.message) };
        }
        return { asked: false, words: said(err?.message ?? err, origin) };
    }
}

const said = (reason, origin) =>
    `The process server did not answer (${reason}). It must allow requests from`
    + ` ${origin}.`;
