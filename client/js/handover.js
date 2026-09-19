// handover.js — assigning a land, and the ground that goes with it.
//
// Split out of client/js/assignland.js, which is the map and the list of who
// is waiting. This is what pressing Assign does: the world decides whether the
// land may be given (Invariant 6), and then the cover inside it is traced onto
// it as the landholder's own shapes (FND.13).

import * as api from './api.js';
import { copyCoverTo } from './covertrace.js';
import { ringOf } from './assignland.js';

// The cover inside a new land, copied onto it. A world with no cover mapped
// has nothing to copy and says nothing; a failure here is said and is not
// allowed to unmake the assignment, which has already happened.
async function handOverCover(areaId, name, say) {
    if (!areaId) return;
    try {
        const area = await api.rpc('one_land', { id: areaId });
        if (!area) return;
        say(`${name} assigned — reading the ground\u2026`);
        const got = await copyCoverTo(area, {
            onStep: (what) => say(`${name} assigned — tracing ${what.value}\u2026`),
        });
        if (got.copied) say(`${name} assigned. Cover copied: ${got.copied} shape(s).`);
    } catch (err) {
        say(`${name} assigned, but its cover could not be copied:`
            + ` ${String(err.body?.message ?? err.message ?? err)}`, true);
    }
}

// Invariant 6: what may be assigned, to whom, and whether it is even in this
// world is the database's to say — and what it says goes on the screen.
export async function handOver(state, boundary, nameField, say, refresh) {
    if (!state.chosen) { say('Nobody is waiting for land.', true); return; }
    const ring = ringOf(boundary.value);
    if (!ring) { say('Put at least three corners on the map first.', true); return; }
    try {
        const done = await api.rpc('assign_land', {
            request_id: state.chosen,
            geojson: { type: 'Polygon', coordinates: [ring] },
            name: nameField.value,
        });
        say(`${done.name} assigned to ${done.who}.`);
        // FND.13: the ground goes with the land. What the operator's cover
        // says is on it becomes the landholder's own shapes, traced here
        // (Invariant 9) — nothing is rendered, which is still story 2's rule.
        await handOverCover(done.area_id, done.name, say);
        state.corners = [];
        boundary.value = '';
        await refresh();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}
