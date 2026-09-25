// olboot.js — OpenLayers, on demand (EDT.19).
//
// The built bundle is a classic script that hangs `ol` on window; its ES
// modules import each other by bare specifier, which a client with no bundler
// cannot resolve. So it is loaded the first time somebody opens Survey → Areas
// and never at page load: the vendored copy (`make vendor`) first, the CDN
// second — the same two steps edit.html takes.

const HERE = new URL('.', import.meta.url);
const CDN = 'https://cdn.jsdelivr.net/npm/ol@10.10.0';
let loading = null;

function add(tag, attrs) {
    return new Promise((resolve, reject) => {
        const node = Object.assign(document.createElement(tag), attrs);
        node.onload = () => resolve(node);
        node.onerror = () => {
            node.remove();
            reject(new Error(`could not load ${attrs.src ?? attrs.href}`));
        };
        document.head.append(node);
    });
}

export function loadOl() {
    if (globalThis.ol) return Promise.resolve(globalThis.ol);
    loading = loading ?? (async () => {
        await add('link', { rel: 'stylesheet', href: new URL('../vendor/ol/ol.css', HERE).href })
            .catch(() => add('link', { rel: 'stylesheet', href: `${CDN}/ol.css` }));
        await add('script', { src: new URL('../vendor/ol/ol.js', HERE).href })
            .catch(() => add('script', { src: `${CDN}/dist/ol.js` }));
        if (!globalThis.ol) throw new Error('OpenLayers loaded but defined nothing');
        return globalThis.ol;
    })();
    return loading;
}
