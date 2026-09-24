// flowsbar.js — the one bar over the Automate view.
//
// Split out of flowsui.js only for size: it is the row of buttons and the two
// words beside them — whether there is anything unsaved, and what the last
// thing the view did has to say.

import { el } from './poolui.js';

const button = (cls, text, primary = false) => el('button', {
    type: 'button', className: primary ? `primary ${cls}` : cls, textContent: text,
});

export function topBar() {
    const name = el('span', { className: 'name', textContent: 'Flows' });
    const dirty = el('span', { className: 'fl-dirty', textContent: 'unsaved changes' });
    dirty.hidden = true;
    const said = el('span', { className: 'fl-said' });
    const save = button('fl-save', 'Save', true);
    const validate = button('fl-validate', 'Validate');
    const exportBtn = button('fl-export', 'Export');
    const importBtn = button('fl-import', 'Import');
    // FL.3: the saved flow, to the chosen process server.
    const send = button('fl-send', 'Send');
    // FL.3, design 10b: a process opened from a server is read-only here, and
    // the one thing to do with it is keep a copy.
    const ro = el('span', { className: 'fl-ro', textContent: 'Read-only',
        title: 'Read-only \u00b7 the bytes as the server has them' });
    ro.hidden = true;
    const keep = button('fl-keep', 'Save into my land…', true);
    keep.hidden = true;
    const undo = button('fl-undo', 'Undo · Ctrl-Z');
    const redo = button('fl-redo', 'Redo · Ctrl-Shift-Z');
    const relayout = button('fl-layout', 'Auto-layout');
    const close = button('fl-close', 'Close');
    // FL.1: which process server the view talks to (serverpicker.js).
    const server = el('span', { className: 'fl-srv' });
    const node = el('div', { className: 'fl-top' },
        name, ro, undo, redo, relayout, server,
        el('span', { className: 'spacer' }), dirty, said,
        save, keep, validate, send, exportBtn, importBtn, close);

    return {
        node, name, dirty, said, save, undo, redo, server, send, ro, keep,
        // The canvas exists only once litegraph has loaded, so the buttons are
        // wired then rather than when they are built.
        wire(canvas, on) {
            save.onclick = on.save;
            close.onclick = on.close;
            validate.onclick = on.validate;
            exportBtn.onclick = on.exportElx;
            importBtn.onclick = on.importElx;
            send.onclick = on.send;
            keep.onclick = on.keep;
            undo.onclick = () => canvas.undo();
            redo.onclick = () => canvas.redo();
            relayout.onclick = () => canvas.relayout();
        },
    };
}
