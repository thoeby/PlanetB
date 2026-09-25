// nodewatch.mjs — the operator's node takes every file the store holds.
//
// TASKS-live.md LV.11/LV.14. The store is nginx (or server/) writing files
// under FILES_ROOT; the node reads what lands there rather than being handed
// it on the way in — nginx's WebDAV PUT and a mirrored request body do not
// go together. On start it takes what is already there and not yet taken
// (the backfill); after that it watches. A file is taken once its bytes are
// the sha256 its name says, so a file still being written is left for the
// event that finishes it. What was taken and recorded is listed in
// `blocks/.taken`, one sha256 a line, and never taken again.

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const STORED = /^(?:tiles\/\d+\/\d+\/\d+|assets)\/([0-9a-f]{64})\.[a-z0-9]+$/;

function* walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
        const at = join(dir, name);
        if (statSync(at, { throwIfNoEntry: false })?.isDirectory()) yield* walk(at);
        else yield at;
    }
}

// `keep(bytes, sha256)` adds and records, resolving to null when the world
// took it and to what it said otherwise.
export function watchStore(root, keep, log = () => {}) {
    const index = join(root, 'blocks', '.taken');
    const taken = new Set(existsSync(index)
        ? readFileSync(index, 'utf8').split('\n').filter(Boolean) : []);
    let queue = Promise.resolve();

    const take = (file) => {
        const rel = relative(root, file).split(sep).join('/');
        const m = STORED.exec(rel);
        if (!m || taken.has(m[1])) return;
        queue = queue.then(async () => {
            if (taken.has(m[1]) || !existsSync(file)) return;
            const bytes = readFileSync(file);
            if (createHash('sha256').update(bytes).digest('hex') !== m[1]) return;
            const refused = await keep(bytes, m[1]).catch((e) => e.message);
            if (refused) { log(`not recorded ${rel}: ${refused}`); return; }
            taken.add(m[1]);
            appendFileSync(index, `${m[1]}\n`);
        });
    };

    for (const top of ['assets', 'tiles']) for (const file of walk(join(root, top))) take(file);
    const watcher = watch(root, { recursive: true }, (_, name) => {
        if (name) take(join(root, name));
    });
    return { taken, close: () => watcher.close(), settled: () => queue };
}
