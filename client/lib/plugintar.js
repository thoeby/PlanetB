// plugintar.js — a plugin folder as one canonical file (LV.7).
//
// A plugin is a folder: plugin.xml and the composites under assets/. Sold as a
// product it is one artifact, so the folder is written as a tar in one way
// only — entries sorted by path, no directories, no owner, mode 0644, mtime 0
// (client/lib/tar.js) — and the same folder is always the same bytes, the same
// sha256 and the same SAN. tools/register.py writes the same bytes.
//
// Pure: bytes in, bytes out.

import { readTar, writeTar } from './tar.js';

export const ALGO = 'plugin-tar-v1';

const text = (bytes) => new TextDecoder().decode(bytes);

// A tar of a folder may carry the folder's own name in front of every path;
// the plugin is what is under it.
function rooted(files) {
    if (files.has('plugin.xml')) return files;
    const tops = [...files.keys()].filter((n) => /^[^/]+\/plugin\.xml$/.test(n));
    if (tops.length !== 1) return files;
    const top = tops[0].slice(0, -'plugin.xml'.length);
    return new Map([...files].filter(([n]) => n.startsWith(top))
        .map(([n, b]) => [n.slice(top.length), b]));
}

export function pluginOf(xml) {
    const id = /<plugin[^>]*\bid="([^"]+)"/.exec(xml)?.[1] ?? null;
    return { id, blocks: (xml.match(/<node id="/g) ?? []).length };
}

// Any tar of a plugin folder -> the canonical one, and what it is.
export function canonPlugin(bytes) {
    const files = rooted(readTar(bytes));
    const xml = files.get('plugin.xml');
    if (!xml) throw new Error('there is no plugin.xml in this folder');
    const { id, blocks } = pluginOf(text(xml));
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
        throw new Error('its plugin.xml does not say an id');
    }
    const entries = [...files].filter(([n]) => n && !n.endsWith('/'))
        .map(([name, b]) => ({ name, bytes: b }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { bytes: writeTar(entries), id, blocks, files: entries.map((e) => e.name) };
}
