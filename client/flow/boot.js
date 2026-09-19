// boot.js — litegraph, on demand.
//
// litegraph is a classic script that hangs LiteGraph, LGraph and LGraphCanvas
// on window; it is not an ES module and there is no bundler to make it one
// (CLAUDE.md). So it is loaded the first time somebody opens Automate and never
// at page load: a player who never draws a flow never pays for it.

import { parsePlugin } from './plugins/parse.js';
import { registerPlugin as intoRegistry, clear as clearRegistry } from './plugins/registry.js';
import { registerPlugin as intoLiteGraph } from './graph/register.js';
import { applyWireonTheme } from './graph/theme.js';
import { installNamedNetRendering } from './graph/namednets.js';
import { installHiddenOutputRendering } from './graph/hideoutputs.js';

const HERE = new URL('.', import.meta.url);

let loading = null;

function addOnce(tag, attrs) {
    return new Promise((resolve, reject) => {
        const node = Object.assign(document.createElement(tag), attrs);
        node.onload = () => resolve(node);
        node.onerror = () => reject(new Error(`could not load ${attrs.src ?? attrs.href}`));
        document.head.append(node);
    });
}

// The engine itself: the stylesheet first so the canvas is never drawn unstyled.
async function loadLiteGraph() {
    if (globalThis.LiteGraph) return globalThis;
    await addOnce('link', { rel: 'stylesheet',
        href: new URL('../vendor/litegraph/litegraph.css', HERE).href });
    await addOnce('link', { rel: 'stylesheet', href: new URL('../flow.css', HERE).href });
    await addOnce('script', { src: new URL('../vendor/litegraph/litegraph.js', HERE).href });
    if (!globalThis.LiteGraph) throw new Error('litegraph loaded but defined nothing');
    return globalThis;
}

// The bundled block set, parsed and registered twice over: once in the plugin
// registry (what a block is) and once in litegraph (what can be dropped on the
// canvas). A plugin that will not parse is skipped rather than taking the rest
// of the palette with it.
export function registerPlugins(xmls, LiteGraph) {
    let blocks = 0;
    const failed = [];
    for (const { id, xml } of xmls) {
        try {
            const def = parsePlugin(xml);
            intoRegistry(def);
            blocks += intoLiteGraph(def, LiteGraph).length;
        } catch (err) {
            failed.push(`${id}: ${err.message}`);
        }
    }
    return { plugins: xmls.length - failed.length, blocks, failed };
}

// Everything the Automate view needs before it can draw anything, once per
// page. `plugins` is the list flows.js fetched.
export function bootFlow(plugins) {
    loading = loading ?? (async () => {
        const g = await loadLiteGraph();
        const { LiteGraph, LGraph, LGraphCanvas } = g;
        // Before anything is registered: registerNodeType copies
        // LGraphNode.prototype onto each type as it goes, so a type registered
        // before the theme is installed keeps litegraph's own port geometry.
        applyWireonTheme();
        clearRegistry();
        const counted = registerPlugins(await plugins, LiteGraph);
        installNamedNetRendering(LGraphCanvas);
        installHiddenOutputRendering(LGraphCanvas);
        return { LiteGraph, LGraph, LGraphCanvas, ...counted };
    })();
    return loading;
}

// The theme is per canvas, so it is applied on each one rather than at boot.
export const dress = (canvas, graph) => applyWireonTheme(canvas, graph);
