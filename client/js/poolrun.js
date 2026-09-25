// poolrun.js — one job, taken out of the pool by the player who pressed
// Render: claim, run, upload, submit, until this tab has nothing left it can
// do on it, and then what the world says about the tile afterwards.
//
// Split from client/js/renderpool.js, which draws the queues; this is the
// press of the button.

import * as api from './api.js';
import { DOING, beyond, drawnWhen, what } from './poolui.js';

const said = (err) => String(err?.body?.message ?? err?.message ?? err);

// How long a lane that has nothing to claim waits before asking again, while
// another lane is still working. A piece that unblocks the next one does so
// when it is submitted, and nothing tells the other lanes.
const LANE_WAIT_MS = 400;

// The job of the same tile that stands where `entry` stood, if the pool now
// shows another one: a finer tile under it published while this tab was
// merging, so ensure_job cancelled the job in hand and opened the next
// (db/0110). The tile is what the player pressed, not the job number, so the
// tab follows it — once per job, so two tabs trading publishes cannot keep
// one of them going round for ever.
export function replacement(entry, rows, tried) {
    const now = (rows ?? []).find((r) => r.z === entry.z && r.x === entry.x && r.y === entry.y);
    if (!now || now.job === entry.job || tried.has(now.job)) return null;
    return Number(now.ready) > 0 ? now : null;
}

// One job, to the end, in as many lanes as the tab runs (client/js/work.js
// LANES). A tile's frames are three atoms with no order between them, so a
// press of Render that did them one after another left the network idle while
// the GPU worked and the GPU idle while it uploaded.
//
// A lane with nothing to claim does not go home while another lane is still
// holding a piece: what that piece unblocks is this job's next atom, and the
// lane that gave up is the one that would have taken it.
async function drive(work) {
    const lane = async () => {
        for (;;) {
            if (await work.step()) continue;
            if (!work.working?.size) return;
            await new Promise((r) => setTimeout(r, LANE_WAIT_MS));
        }
    };
    const lanes = await Promise.allSettled(
        Array.from({ length: Math.max(1, work.lanes ?? 1) }, lane));
    // One lane's failure is the job's: the others are told nothing by it, and
    // the message belongs on the panel whichever lane hit it.
    const bad = lanes.find((l) => l.status === 'rejected');
    if (bad) throw bad.reason;
}

// What the world says about the tile afterwards, not what this tab hoped:
// publish_tile is a compare-and-swap, and losing it is a thing to be told.
//
// And when it did not publish, why. "n piece(s) left — press Render again"
// was said for every reason the pool refuses a piece (db/0218 job_refusal),
// and for a claim that failed outright, and pressing Render again said it
// again. The world is asked which it is.
export async function landed(tile, entry, rows, work) {
    const [row] = await api.select('tile',
        { z: `eq.${entry.z}`, x: `eq.${entry.x}`, y: `eq.${entry.y}`,
            select: 'published_version' }).catch(() => []);
    if (Number(row?.published_version ?? 0) >= Number(entry.version)) {
        const more = drawnWhen(entry);
        return `${tile} is published${more ? ` — ${more}` : ''}`;
    }
    if (work?.claimFailures > 0 && work.lastClaimError) {
        return `${tile}: the claim failed — ${work.lastClaimError}`;
    }
    // By tile, not by job: a job the world no longer builds is reopened as
    // another job at the same version while this tab is on it (db/0179).
    const now = (rows ?? []).find((r) => r.z === entry.z && r.x === entry.x && r.y === entry.y);
    if (!now) {
        return `${tile}: every piece is done and the publish did not land —`
            + ' the world moved on while this tab was working. Submit it again.';
    }
    if (Number(now.claimed) > 0 && !Number(now.ready)) {
        return `${tile}: ${now.claimed} piece(s) are in somebody else's hands.`;
    }
    if (!Number(now.ready)) {
        return `${tile}: nothing left that anybody can take — ${now.failed || 0}`
            + ' gave up, and the rest are waiting on it. Try again puts it back.';
    }
    const why = await api.rpc('job_refusal', { job_id: now.job, caps: work?.caps ?? {} })
        .catch(() => null);
    if (why) return `${tile}: ${now.ready} piece(s) left — ${why}.`;
    if (beyond(now, work?.caps)) {
        return `${tile}: ${now.ready} piece(s) left, and they want more of a GPU`
            + ' than this tab has. Another machine can take them.';
    }
    return `${tile}: ${now.ready} piece(s) left — press Render again.`;
}

// The press of Render: the job, and the job that replaces it while the tab is
// on it, until the tile is published or nothing here can take it further.
export async function runJob(entry, button, { state, loop, say, refresh, draw }) {
    // A tab does one job at a time (WorkLoop.focus), so taking a second while
    // the first is running would only have it claim nothing and say so.
    if (state.running) {
        say('this tab is already on a job — wait for it, or open another tab', true);
        return;
    }
    const work = await loop();
    if (!work) { say('nothing here can render', true); return; }
    if (!api.token()) { say('sign in first — the work is paid for', true); return; }
    state.running = entry.job;
    button.disabled = true;
    draw();
    const tile = `${entry.z}/${entry.x}/${entry.y}`;
    say(`rendering ${tile}… ${what(entry)}`);
    let at = entry;
    work.focus(at.job);
    let refreshed = false;
    // SPEC §3.7: assembling… framing… training… published. The atom the loop
    // is on is what this tab is doing, and a compile is minutes long: a panel
    // that says nothing until the end says nothing at all.
    const watch = setInterval(() => {
        const op = work.atom?.op;
        if (op) say(`${tile} · ${DOING[op] ?? op}…`);
    }, 500);
    try {
        const tried = new Set([at.job]);
        let rows;
        for (;;) {
            await drive(work);
            rows = await refresh();
            const next = replacement(at, rows, tried);
            if (!next) break;
            tried.add(next.job);
            say(`${tile}: the land under it changed — going on with job ${next.job}…`);
            at = next;
            state.running = at.job;
            work.focus(at.job);
        }
        say(await landed(tile, at, rows, work));
        refreshed = true;
    } catch (err) {
        say(said(err), true);
    } finally {
        clearInterval(watch);
        work.focus(null);
        state.running = null;
        button.disabled = false;
        if (!refreshed) await refresh();
        else draw();
    }
}
