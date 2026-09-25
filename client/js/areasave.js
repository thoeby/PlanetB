// areasave.js — Save in Survey → Areas (EDT.20, EDT.21; PLAN-editors.md
// idea 30): every new or changed area written, every erased one taken away,
// through the same row-level security as everything else (Invariant 6).
//
// Two areas of the same kind that overlap become one; a new area of another
// kind cuts a hole in what it lies over. The rule is said once in the panel
// and the save says what it did: "forest saved · merged with 1".

import { dropFeature, saveFeature } from './edit.js';
import { difference, overlaps, union } from '../lib/polyops.js';

/**
 * The areas as they will be written: each unsaved one joined with the older
 * ones of its kind it overlaps (those go), and cutting the older ones of other
 * kinds it lies over — the newest drawn wins. Answers what it did, per area,
 * for the sentence.
 */
export function settle(areas) {
    const said = [];
    const order = [...areas.items];
    order.forEach((a, i) => {
        if (a.state !== 'new' && a.state !== 'changed') return;
        let merged = 0;
        let cut = 0;
        for (const b of order.slice(0, i)) {
            if (gone(b) || gone(a) || !overlaps(a.polys, b.polys)) continue;
            if (b.kind === a.kind && b.props?.[b.kind] === a.props?.[a.kind]) {
                a.polys = union(a.polys, b.polys);
                b.state = b.id ? 'deleted' : 'gone';
                merged += 1;
            } else {
                b.polys = difference(b.polys, a.polys);
                if (!b.polys.length) b.state = b.id ? 'deleted' : 'gone';
                else if (b.state === 'saved') b.state = 'changed';
                cut += 1;
            }
        }
        said.push({ area: a, merged, cut });
    });
    areas.items = areas.items.filter((x) => x.state !== 'gone');
    return said.filter((x) => !gone(x.area));
}

const gone = (a) => a.state === 'gone' || a.state === 'deleted';

export const sentence = ({ area, merged, cut }) => {
    const what = area.props?.[area.kind] ?? area.kind;
    const bits = [`${what} saved`];
    if (merged) bits.push(`merged with ${merged}`);
    if (cut) bits.push(`cut ${cut}`);
    return bits.join(' · ');
};

export async function saveAreas(areas) {
    const said = settle(areas);
    for (const a of areas.items) {
        if (a.state === 'deleted') await dropFeature(areas.land, a.id);
        else if (a.state !== 'saved') {
            const got = await saveFeature(areas.land, areas.featureOf(a));
            a.id = got.id ?? a.id;
        }
    }
    const erased = areas.items.filter((a) => a.state === 'deleted').length;
    areas.items = areas.items.filter((a) => a.state !== 'deleted');
    for (const a of areas.items) a.state = 'saved';
    areas.past.length = 0;
    areas.future.length = 0;
    const words = said.map(sentence);
    if (erased && !said.length) words.push(`${erased} area${erased === 1 ? '' : 's'} erased`);
    return words.join('; ') || 'nothing to save';
}
