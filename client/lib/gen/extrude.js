// extrude.js — an outline pulled up into walls and given a roof.
//
// The footprint logic `assemble` has had since WP2, one feature at a time:
// the walls stand half a metre under the lowest ground the outline touches,
// and the roof is built on the outline's oriented box rather than on the
// outline itself — a gable over an arbitrary polygon is a straight skeleton,
// and at a tile's distance nobody is counting its edges.
//
// Parameters: `height` (m), `roof` (flat · gable · hip), `roof_colour`.

import { extrudeOne } from '../props.js';

export function run(params, feature, ctx) {
    const box = extrudeOne(feature, ctx.terrain,
        { height: params.height, roof: params.roof, roof_color: params.roof_colour },
        ctx.mesh('wall'), ctx.mesh('roof'));
    return box ? { boxes: [box] } : null;
}
