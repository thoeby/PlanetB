// shapekeep.js — what a player shaped and could not save, kept on this
// machine until it can be (EDT.10, PLAN-editors.md §2.2).
//
// A save writes a new r32 to the file store and then a row through PostgREST
// (client/js/sculpt.js save); either may not be answering. Then the grid is
// written into the tab's own storage, the panel offers Retry, and a reload
// puts it back as one stroke — undoable, and still not saved.
//
// Nothing here writes to the world. Invariant 1 is the save's: the kept bytes
// are only ever handed to it again.

import { readR32, writeR32 } from '../lib/r32.js';
import { dropKept, keepFile, readKept } from '../lib/opfs.js';

const PATH = ['splatworld', 'shape-pending'];
const name = (areaId) => `${areaId}.r32`;

export async function keep(shaping) {
    const bytes = writeR32(shaping.grid);
    await keepFile(PATH, name(shaping.area.id), bytes);
    return bytes.byteLength;
}

export const forget = (shaping) => dropKept(PATH, name(shaping.area.id));

/**
 * Puts back what was kept for this land, as one stroke, if the grid is the
 * same size; answers how many cells differ from what the world holds.
 */
export async function restore(shaping) {
    const bytes = await readKept(PATH, name(shaping.area.id));
    if (!bytes) return 0;
    let kept;
    try {
        kept = readR32(bytes);
    } catch {
        return 0;
    }
    const { data, width, height } = shaping.grid;
    if (kept.width !== width || kept.height !== height) return 0;
    shaping.begin({ brush: 'putback', words: 'Kept on this machine' });
    let moved = 0;
    for (let k = 0; k < data.length; k++) {
        if (kept.data[k] === data[k]) continue;
        shaping.remember(k);
        data[k] = kept.data[k];
        moved += 1;
    }
    shaping.mark(shaping.stroke);
    shaping.end();
    return moved;
}
