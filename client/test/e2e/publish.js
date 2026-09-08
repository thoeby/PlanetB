// Publishes a new version of an already-published tile, through the same
// functions PostgREST would call: dirty the world, ensure_job, claim, submit,
// publish_tile with its compare-and-swap. Only the upload is short-circuited —
// the bytes are written straight into the file store, which the page's routes
// read off disk. tools/files-test.sh is what covers the PUT path.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packSog } from '../../../tools/sogwrite.mjs';
import { makeSplats } from '../../../tools/testterrain.mjs';
import { FILES_ROOT } from './serve.js';

const psql = (sql) => execFileSync('psql',
    ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-t', '-A', '-c', sql],
    { encoding: 'utf8', env: process.env }).trim();

// The same tile, lifted a little: different bytes, so a different sha256, so
// the viewer has something it can tell apart. The lift is random because the
// store never takes the same content twice and a suite may republish more than
// once.
function newBytes(z, x, y) {
    const { splats } = makeSplats(z, x, y);
    const lift = 1 + Math.random();
    for (let i = 0; i < splats.count; i++) splats.y[i] += lift;
    return packSog(splats).bytes;
}

// Everything claim_atom could hand back is set aside first, so it can only hand
// back this job's work. Claimed atoms count: expire_claims() runs inside
// claim_atom and frees whatever a dead worker left behind, which is exactly what
// an abandoned api-test run leaves lying around. They go back at the end.
function publishSql(z, x, y, sha, size) {
    return `
        DO $$
        DECLARE
            uid uuid;
            jid bigint;
            ev  bigint;
            a      atom%rowtype;
            parked bigint [];
            ply    text := encode(public.digest(random()::text, 'sha256'), 'hex');
        BEGIN
            SELECT id INTO uid FROM auth.user WHERE email = 'test-tiles@splatworld.local';
            PERFORM set_config('request.jwt.claims',
                json_build_object('sub', uid, 'role', 'admin')::text, true);

            -- An edit, which is the only thing that makes a tile stale.
            UPDATE feature SET props = props || jsonb_build_object('bump', now()::text);
            SELECT expected_version INTO ev FROM tile
            WHERE tile.z = ${z} AND tile.x = ${x} AND tile.y = ${y};
            jid := ensure_job(${z}, ${x}, ${y});

            SELECT array_agg(id) INTO parked
            FROM atom WHERE state IN ('ready', 'claimed') AND job_id <> jid;
            UPDATE atom SET state = 'ready', worker_id = NULL, claimed_at = NULL,
                heartbeat_at = NULL
            WHERE id = ANY (coalesce(parked, '{}'::bigint [])) AND state = 'claimed';
            UPDATE atom SET state = 'waiting'
            WHERE id = ANY (coalesce(parked, '{}'::bigint []));

            LOOP
                SELECT * INTO a FROM claim_atom('{}'::jsonb);
                EXIT WHEN a.id IS NULL;
                IF a.job_id <> jid THEN
                    RAISE EXCEPTION 'claimed atom % of job %, not %', a.id, a.job_id, jid;
                END IF;
                IF a.op = 'merge' THEN
                    PERFORM register_artifact(ply, 'ply', 1024, 'merge-v1');
                    PERFORM submit_atom(a.id, ply,
                        '{"splat_count": 1000, "bytes": 1024}'::jsonb);
                ELSE
                    PERFORM register_artifact('${sha}', 'sog', ${size}, 'sog-v1');
                    PERFORM submit_atom(a.id, '${sha}',
                        jsonb_build_object('splat_count', 1000, 'bytes', ${size}));
                END IF;
            END LOOP;

            UPDATE atom SET state = 'ready'
            WHERE id = ANY (coalesce(parked, '{}'::bigint []));

            IF NOT publish_tile(${z}, ${x}, ${y}, ev, '${sha}',
                (SELECT manifest FROM tile
                 WHERE tile.z = ${z} AND tile.x = ${x} AND tile.y = ${y})) THEN
                RAISE EXCEPTION 'publish_tile refused version %', ev;
            END IF;
            RAISE NOTICE 'published % at %', '${sha}', ev;
        END $$;
        SELECT sog_sha256 FROM tile WHERE z = ${z} AND x = ${x} AND y = ${y};`;
}

export function republish(z, x, y) {
    const bytes = newBytes(z, x, y);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dir = join(FILES_ROOT, 'tiles', String(z), String(x), String(y));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sha}.sog`), bytes);

    const out = psql(publishSql(z, x, y, sha, bytes.length));
    const got = out.split('\n').pop().trim();
    if (got !== sha) throw new Error(`republish left ${got}, expected ${sha}`);
    return sha;
}
