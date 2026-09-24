// flowsbar.js — the one bar over the Automate view (design 10a).
//
// Split out of flowsui.js only for size: which flow is open and where it
// lives, undo / redo / auto-layout, the Server control, whether anything is
// unsaved and what the view last had to say, and the actions.

import { el } from './poolui.js';

// A button whose accessible name is its word alone; the key beside it is a
// hint, not part of the name.
const button = (cls, text, { primary = false, key = '', label = text } = {}) => {
    const b = el('button', { type: 'button', className: primary ? `primary ${cls}` : cls },
        el('span', { className: 'fl-word', textContent: text }),
        key ? el('kbd', { textContent: key }) : '');
    b.setAttribute('aria-label', label);
    return b;
};

const sep = () => el('span', { className: 'fl-sep' });

export function topBar() {
    const kicker = el('span', { className: 'fl-kicker', textContent: 'Flows' });
    const name = el('span', { className: 'name', textContent: 'Flows' });
    const where = el('span', { className: 'fl-where' });
    const dirty = el('span', { className: 'fl-dirty' }, el('i'), 'unsaved');
    dirty.hidden = true;
    const said = el('span', { className: 'fl-said' });
    const save = button('fl-save', 'Save', { primary: true, key: '⌘S' });
    const validate = button('fl-validate', 'Validate');
    const exportBtn = button('fl-export', 'Export');
    const importBtn = button('fl-import', 'Import');
    // FL.3: the saved flow, to the chosen process server.
    const send = button('fl-send fl-hue', 'Send');
    // FL.7: Run on… for the open flow, the dialog a thing's panel opens.
    const run = button('fl-runon fl-hue', 'Run', { label: 'Run on…' });
    // FL.3, design 10b: a process opened from a server is read-only here, and
    // the one thing to do with it is keep a copy.
    const ro = el('span', { className: 'fl-ro', textContent: 'Read-only',
        title: 'Read-only · the bytes as the server has them' });
    ro.hidden = true;
    const keep = button('fl-keep', 'Save into my land…', { primary: true });
    keep.hidden = true;
    const undo = button('fl-undo', 'Undo', { key: '⌘Z' });
    const redo = button('fl-redo', 'Redo', { key: '⇧⌘Z' });
    const relayout = button('fl-layout', 'Auto-layout', { key: 'L' });
    const close = button('fl-close', 'Close · Esc', { label: 'Close' });
    // FL.1: which process server the view talks to (serverpicker.js).
    const server = el('span', { className: 'fl-srv' });
    const node = el('div', { className: 'fl-top' },
        kicker, name, where, sep(),
        el('span', { className: 'fl-group' }, undo, redo, relayout), sep(), server,
        el('span', { className: 'spacer' }, dirty, said),
        el('span', { className: 'fl-group fl-acts-top' },
            ro, save, keep, validate, send, run, exportBtn, importBtn, sep(), close));

    return {
        node, name, where, dirty, said, save, undo, redo, server, send, run, ro, keep,
        // The canvas exists only once litegraph has loaded, so the buttons are
        // wired then rather than when they are built.
        wire(canvas, on) {
            save.onclick = on.save;
            close.onclick = on.close;
            validate.onclick = on.validate;
            exportBtn.onclick = on.exportElx;
            importBtn.onclick = on.importElx;
            send.onclick = on.send;
            run.onclick = on.run;
            keep.onclick = on.keep;
            undo.onclick = () => canvas.undo();
            redo.onclick = () => canvas.redo();
            relayout.onclick = () => canvas.relayout();
        },
    };
}
