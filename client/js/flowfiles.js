// flowfiles.js — a flow as a file: in, and out.
//
// SPEC §2.16, FND.2. Import takes an .elx a process server wrote and puts it on
// a land as a new flow; export gives back exactly the bytes that were saved.
// "Exactly" is the whole point: the world is the transport, and a flow that
// went out different from how it came in would be this editor rewriting
// somebody else's file.

import * as flows from './flows.js';

// "create-albumlist.elx" -> "create-albumlist", and then a name nobody on that
// land is using: "create-albumlist 2".
export function fileName(path, taken) {
    const base = String(path).replace(/\.[^.]*$/, '').split(/[\\/]/).pop().trim()
        || 'imported flow';
    if (!taken.includes(base)) return base;
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

// The ELX of a file the player picked. Rejected here rather than by the parser
// so the sentence names the file.
export async function readElx(file) {
    const text = await file.text();
    if (!/<\s*elx[\s>]/.test(text)) {
        throw new Error(`${file.name} is not an ELX flow.`);
    }
    return text;
}

// An imported flow is a saved flow at once, like a new one: it is on the land
// from the moment it arrives, and the canvas lays it out because the file
// carries no layout (it never does — that is the format's rule).
export async function importElx(file, areaId, taken) {
    const elx = await readElx(file);
    const name = fileName(file.name, taken);
    const res = await flows.saveFlow({ areaId, name, elx, layout: {} });
    return { ...res, name, elx };
}

// The saved bytes, as a download. Not a re-serialization of what is on the
// canvas: those are the same only when nothing is unsaved, and the caller has
// already refused to export a dirty flow.
export function download(name, elx, doc = document) {
    const url = URL.createObjectURL(new Blob([elx], { type: 'application/xml' }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = `${name}.elx`;
    a.rel = 'noopener';
    doc.body.append(a);
    a.click();
    a.remove();
    // Revoked on the next turn: revoking before the click has been handled
    // leaves the browser downloading nothing at all.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return url;
}
