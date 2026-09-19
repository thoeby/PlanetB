// roadcheck.js — the roads on a land that cannot be driven across.
//
// FND.11. `client/lib/gen/check.js` is the measurement, and the compiler runs
// it over every line of a tile. This runs the same code in the page, over one
// land's own lines, so the Submit dialog can say what an approver is about to
// be shown before anything is sent.
//
// It is a warning, never a refusal: a road across a slope is a road somebody
// may mean to build.

import * as api from './api.js';
import { flagsAlong } from '../lib/gen/check.js';

const M_PER_LAT = 110540;
const mPerLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * @param {object} area a land, as area_view gives it
 * @param {(lon: number, lat: number) => number} ground metres above the sea
 * @param {object} params {width, max_cross_slope, every}
 */
export async function steepRoads(area, ground, params = {}) {
    const rows = await api.rpc('area_lines', { area: area.id }).catch(() => []);
    const mid = area.centre ?? { lon: area.bbox?.west ?? 0, lat: area.bbox?.south ?? 0 };
    const scale = mPerLon(mid.lat);
    // The lines in metres around the land's own middle, which is close enough
    // for a cross-slope over a few metres.
    const toLocal = ([lon, lat]) => [(lon - mid.lon) * scale, (mid.lat - lat) * M_PER_LAT];
    const back = ([x, z]) => ({ lon: mid.lon + x / scale, lat: mid.lat - z / M_PER_LAT });
    const out = [];
    for (const row of rows ?? []) {
        const lines = linesOf(row.geom).map((line) => line.map(toLocal));
        const heightAt = (x, z) => {
            const g = back([x, z]);
            return ground(g.lon, g.lat) ?? 0;
        };
        for (const flag of flagsAlong(lines, params, heightAt)) {
            out.push({ ...back([flag.x, flag.z]), slope: flag.slope,
                name: row.props?.name || row.kind });
        }
    }
    return out;
}

const linesOf = (geom) => {
    if (geom?.type === 'LineString') return [geom.coordinates];
    if (geom?.type === 'MultiLineString') return geom.coordinates;
    return [];
};

// "Road too steep across at 3 places" — the sentence the dialog says.
export const steepWords = (flags) => (flags?.length
    ? `Road too steep across at ${flags.length} place${flags.length === 1 ? '' : 's'}`
    : '');
