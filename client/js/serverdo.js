// serverdo.js — what the Automate view does with a process server's processes
// (TASKS-flows.md FL.3).
//
// Three things, each starting from something the player pressed: look at a
// process that is on a server, make one a flow of the world's, and send a
// world flow to the chosen server. Split from flowsdo.js for size.

import * as flows from './flows.js';
import { ask, landPicker } from './flowlist.js';
import { importFiles } from './flowsdo.js';
import { processApi } from '../flow/server/process.js';
import { failWords } from '../flow/server/client.js';

// A process as it is on the server, on the canvas, where it cannot be changed:
// it is not the world's, so there is nothing to save it into but a land.
export async function openRemote(ctx, server, row) {
    const canvas = await ctx.boot();
    const elx = await processApi(server.url).elx(row.id);
    canvas.open(ctx.parse(elx), {});
    canvas.view.read_only = true;
    ctx.state.open = null;
    ctx.state.remote = { server, row, elx };
    ctx.bar.name.textContent = `${row.name} · on ${server.name}`;
    ctx.bar.where.textContent = '';
    ctx.mark(false);
    ctx.say(`${row.name} is on ${server.name}; Save into my land… to change it`);
}

// Save into my land…: the bytes exactly as the server gave them, on a land the
// player builds on, under a name they choose — the same path an imported file
// takes (FND.2), so it exports as it came.
export async function intoLand(ctx, server, row) {
    const elx = await processApi(server.url).elx(row.id);
    const lands = await ctx.lands();
    if (!lands.length) {
        ctx.say('You build on no land yet, so there is nowhere to put a flow.');
        return;
    }
    const picker = landPicker(lands);
    const box = ask(ctx.root, {
        title: `Save ${row.name} from ${server.name} into my land`, value: row.name,
        ok: 'Save',
        onOk: async (name) => {
            if (!name) throw new Error('A flow needs a name.');
            const file = new window.File([elx], `${name}.elx`, { type: 'application/xml' });
            ctx.state.remote = null;
            await importFiles(ctx, [file], picker.value);
        },
    });
    box.node.querySelector('div').insertBefore(picker, box.input);
}

// Send to <server>: the flow's saved bytes, as a process of the same name. A
// server that already has one by that name is asked about, not overwritten
// without a word: the same name sends over it, another name makes a new one.
export async function sendFlow(ctx) {
    const server = ctx.server.current();
    const open = ctx.state.open;
    if (!server) { ctx.say('Choose a server first.'); return null; }
    if (!open) { ctx.say('Open a flow of yours first.'); return null; }
    if (ctx.state.dirty) { ctx.say('save first'); return null; }
    const api = processApi(server.url);
    try {
        const elx = await flows.elxOf(open.elx_sha256);
        const there = (await api.list()).find((p) => p.name === open.name);
        if (!there) return sent(ctx, server, await api.create(open.name, elx));
        return await new Promise((resolve) => {
            ask(ctx.root, {
                title: `${server.name} already has a process called ${open.name}.`
                    + ' Keep the name to send over it, or type another.',
                value: open.name, ok: 'Send',
                onOk: async (name) => {
                    if (name === there.name) {
                        await api.update(there.id, elx);
                        resolve(sent(ctx, server, there));
                    } else resolve(sent(ctx, server, await api.create(name, elx)));
                },
                onCancel: () => resolve(null), cancelWord: 'Cancel',
            });
        });
    } catch (err) {
        ctx.say(failWords(err, server.name));
        return null;
    }
}

function sent(ctx, server, process) {
    ctx.say(`sent ${process.name} to ${server.name}`);
    ctx.remoteLists?.run();
    return process;
}
