// catalogplugin.js — plugins and flows in the catalog (TASKS-live.md LV.7).
//
// Register takes a plugin folder as a tar (any tar of it: it is rewritten as
// the canonical one, client/lib/plugintar.js) or a flow as its .elx. A plugin
// somebody holds a right to gets **Install on** one of their process servers:
// the tab fetches the tar and sends it there (client/flow/server/plugins.js).

import * as api from './api.js';
import { el } from './poolui.js';
import { publishFlow, publishPlugin, tarUrl } from './catalog.js';
import { canonPlugin } from '../lib/plugintar.js';
import { installPlugin } from '../flow/server/plugins.js';
import { servers } from './processservers.js';

// The file form of the two: what was picked, and what it turned out to be.
export function mountFileForm(doc) {
    const at = (id) => doc.getElementById(id);
    const picked = { type: null, bytes: null, plugin: null };
    at('product-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        const said = at('product-said');
        picked.bytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
        picked.plugin = null;
        if (!picked.bytes) { said.textContent = ''; return; }
        const name = at('name');
        try {
            if (/\.tar$/i.test(file.name)) {
                picked.plugin = canonPlugin(picked.bytes);
                said.textContent = `plugin ${picked.plugin.id} · ${picked.plugin.blocks} blocks`;
                if (!name.value) name.value = picked.plugin.id;
            } else {
                said.textContent = `a flow · ${picked.bytes.length} bytes`;
                if (!name.value) name.value = file.name.replace(/\.elx$/i, '');
            }
        } catch (err) {
            said.textContent = String(err.message ?? err);
        }
    });
    return picked;
}

export async function publishFileProduct(type, picked, meta) {
    if (type === 'plugin') {
        if (!picked.plugin) throw new Error('pick a plugin folder, as a .tar');
        return publishPlugin(picked.plugin, meta);
    }
    if (!picked.bytes) throw new Error('pick a flow, as an .elx');
    return publishFlow(picked.bytes, meta);
}

// The card's Install row: the player's own servers, and one button.
export function installRow(asset, mayInstall) {
    if (asset.type !== 'plugin' || !mayInstall) return null;
    const which = el('select', { className: 'install-server' });
    which.setAttribute('aria-label', 'install on');
    const go = el('button', { type: 'button', className: 'install', textContent: 'Install' });
    const said = el('span', { className: 'install-said status' });
    servers().then((list) => which.replaceChildren(...list.filter((s) => s.url)
        .map((s) => new Option(s.name, s.url)))).catch(() => {});
    go.onclick = async () => {
        const name = which.selectedOptions[0]?.textContent ?? 'the server';
        try {
            const tar = new Uint8Array(await (await fetch(tarUrl(asset))).arrayBuffer());
            const id = asset.parts?.plugin;
            await installPlugin(which.value, id, tar);
            said.textContent = `${asset.name} is on ${name}`;
        } catch (err) {
            said.textContent = `${name} did not take it: ${err.message ?? err}`;
        }
    };
    return el('p', { className: 'install-row' }, 'Install on ', which, ' ', go, ' ', said);
}

export const mayInstall = (asset, held) => held.has(asset.san)
    || asset.creator_id === api.claims()?.sub;
