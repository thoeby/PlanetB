// Headless QGIS, as the story's player uses it.
//
// PLAYER-RUN.md: QGIS opens the project the page downloaded and performs edits
// through the layers exactly as a user would. client/test/run/qgis/draw.py is
// the PyQGIS half; this starts it and reads what it said.
//
// It runs under the system python, not whichever one is on PATH: PyQGIS is
// installed for the python QGIS was packaged against, and no other one can
// import it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO } from './world.js';

const PYTHONS = ['/usr/bin/python3.12', '/usr/bin/python3.11', '/usr/bin/python3'];

export function qgisPython() {
    for (const python of PYTHONS) {
        if (!existsSync(python)) continue;
        const ok = spawnSync(python, ['-c', 'import qgis.core'], { stdio: 'ignore' });
        if (ok.status === 0) return python;
    }
    return null;
}

// One run of one PyQGIS script: the payload in, one JSON object per line out.
function inQgis(script, projectPath, payload) {
    const python = qgisPython();
    if (!python) {
        throw new Error('no PyQGIS here — install qgis and python3-qgis, or run'
            + ' the player-run where QGIS is');
    }
    const done = spawnSync(python,
        [join(REPO, 'client/test/run/qgis', script), projectPath, JSON.stringify(payload)],
        { cwd: REPO, encoding: 'utf8', timeout: 300_000,
            // No display here, and none wanted: QGIS draws nothing, it edits.
            env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
    const lines = (done.stdout || '').trim().split('\n').filter(Boolean);
    const results = [];
    for (const line of lines) {
        try { results.push(JSON.parse(line)); } catch { /* QGIS's own chatter */ }
    }
    if (!results.length) {
        throw new Error(`QGIS said nothing: ${done.stderr || done.stdout || done.error}`);
    }
    return results;
}

// edits: {layer, geometry (WKT), attributes} or an array of them.
// Returns one result per edit: {ok, layer, count} or {ok: false, error}.
export function drawInQgis(projectPath, edits) {
    return inQgis('draw.py', projectPath, edits);
}

/**
 * Copy features out of a file and paste them into one of the player's layers,
 * which is what a QGIS user does with an OSM extract (TASKS-foundation.md
 * FND.0). The file is opened beside the project, the filter picks what is
 * wanted — `intersects($geometry, geom_from_wkt('POLYGON((…)))')` is how a
 * story says "the ones inside my land" — the fields are filled by the
 * mapping, and the commit is the player's, under RLS.
 *
 * @param {string} project     path to the player's downloaded .qgs
 * @param {string} layer       the layer in it that is being pasted into
 * @param {string} gpkg        the file being copied from
 * @param {string} sourceLayer the layer inside that file
 * @param {?string} filter     a QGIS expression over the source, or null
 * @param {Object<string,string>} into  target field ← source field (a name
 *                             that is not a source field is used as a value)
 * @returns {{ok: boolean, pasted?: number, count?: number, error?: string}}
 */
export function importFromFile(project, layer, gpkg, sourceLayer, filter, into) {
    const path = gpkg.startsWith('/') ? gpkg : join(REPO, gpkg);
    return inQgis('import.py', project,
        { layer, gpkg: path, source_layer: sourceLayer, filter, into })[0];
}
