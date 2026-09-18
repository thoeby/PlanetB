// terrainmod.js — the shaping operation a drawn area used to carry.
//
// On its way out: FND.11 turns every one of these into a height edit and
// retires the kind. Until then a symbol can still carry it, so that a world
// built under the rules and the same world built under the symbols are the
// same ground.
//
// Parameters: `op` (raise · lower · flatten · smooth) and `amount` (m).

import { applyTerrainmods } from '../terrain.js';

// In `shape`, because everything else is drawn on the ground this leaves.
export function shape(params, feature, ctx) {
    applyTerrainmods(ctx.terrain, [feature], [{ kind: '*', filter: [],
        style: { op: params.op, amount: params.amount } }]);
    return null;
}
