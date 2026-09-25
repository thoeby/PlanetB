// flowblocks.js — the blocks the chosen process server has (TASKS-flows.md FL.2).
//
// The palette is the bundled plugin set (client/flow/palette) plus whatever the
// chosen server lists in /system/plugins/available. Where both have a plugin
// and the server's differs, the server's wins, because it is what will run the
// flow, and the palette says where it came from. A block on the canvas whose
// plugin the chosen server does not have is drawn hatched and the inspector
// says so — it is still saved into the world exactly as it is.

import { registerPlugins } from '../flow/boot.js';
import { serverClient, failWords } from '../flow/server/client.js';
import { children } from '../flow/server/envelope.js';
import { WORLD_PLUGINS } from './flowworld.js';

const idOf = (xml) => /<plugin\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1] ?? '';

// Every plugin XML a server offers, each one entity-encoded in a <descriptor>.
export async function serverPlugins(url) {
    const data = await serverClient(url).request('GET', '/system/plugins/available');
    return children(data, 'descriptor')
        .map((d) => (d.textContent || '').trim())
        .filter(Boolean)
        .map((xml) => ({ id: idOf(xml), xml }));
}

// Where a plugin in the palette came from, in design 10l's words.
function fromWords(state, plugin) {
    const name = state.server?.name ?? '';
    if (plugin === 'world' && state.has?.has('world')) return `${name} knows these blocks`;
    // LV.7: the world's own plugins are bundled for drawing but run only where
    // a server has them installed, so where one has, the palette says so.
    if (WORLD_PLUGINS.has(plugin) && state.has?.has(plugin)) return `from ${name}`;
    return state.from.has(plugin) ? `from ${name}` : '';
}

export function flowBlocks({ LiteGraph, bundled, say }) {
    const mine = new Map(bundled.map((p) => [p.id, p.xml.trim()]));
    const state = { server: null, has: null, from: new Set(), overridden: new Set() };

    // A plugin the last server overrode goes back to the bundle's own before
    // the next server's are laid over it.
    const restore = () => {
        const back = [...state.overridden].filter((id) => mine.has(id))
            .map((id) => ({ id, xml: mine.get(id) }));
        registerPlugins(back, LiteGraph);
        state.overridden.clear();
        state.from.clear();
    };

    async function use(server) {
        restore();
        state.server = server;
        state.has = null;
        if (!server) return { ok: true };
        say?.(`asking ${server.name} for its blocks…`);
        try {
            const list = await serverPlugins(server.url);
            if (state.server !== server) return { ok: false };
            const differ = list.filter((p) => mine.get(p.id) !== p.xml);
            registerPlugins(differ, LiteGraph);
            state.has = new Set(list.map((p) => p.id));
            for (const p of differ) {
                state.from.add(p.id);
                if (mine.has(p.id)) state.overridden.add(p.id);
            }
            say?.(`${list.length} plugins from ${server.name}`);
            return { ok: true };
        } catch (err) {
            say?.(failWords(err, server.name));
            return { ok: false };
        }
    }

    return {
        use,
        again: () => use(state.server),
        server: () => state.server,
        // What the palette shows: the bundle, and what the chosen server has.
        visible: (plugin) => mine.has(plugin) || Boolean(state.has?.has(plugin)),
        from: (plugin) => fromWords(state, plugin),
        // What the chosen server itself has (the bundle, while it is unknown):
        // the kinds of service it can be asked for (FL.4).
        served: (plugin) => (state.has ? state.has.has(plugin) : mine.has(plugin)),
        // Marks every block on the canvas the chosen server does not have. A
        // server that did not answer marks nothing: not knowing is not "has not".
        mark(graph) {
            if (!graph) return;
            let changed = false;
            for (const node of graph._nodes ?? []) {
                const plugin = node._irPlugin;
                const missing = plugin && state.has && !state.has.has(plugin)
                    ? `${state.server.name} has no ${plugin}` : null;
                if ((node._irMissingOn ?? null) !== missing) {
                    node._irMissingOn = missing;
                    changed = true;
                }
            }
            if (changed) graph.setDirtyCanvas(true, true);
        },
    };
}
