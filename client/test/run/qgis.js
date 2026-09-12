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

// edits: {layer, geometry (WKT), attributes} or an array of them.
// Returns one result per edit: {ok, layer, count} or {ok: false, error}.
export function drawInQgis(projectPath, edits) {
    const python = qgisPython();
    if (!python) {
        throw new Error('no PyQGIS here — install qgis and python3-qgis, or run'
            + ' the player-run where QGIS is');
    }
    const done = spawnSync(python,
        [join(REPO, 'client/test/run/qgis/draw.py'), projectPath, JSON.stringify(edits)],
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
