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
    const undo = button('fl-undo', 'Undo · Ctrl-Z');
    const redo = button('fl-redo', 'Redo · Ctrl-Shift-Z');
    const relayout = button('fl-layout', 'Auto-layout');
    const close = button('fl-close', 'Close');
    const node = el('div', { className: 'fl-top' },
        name, undo, redo, relayout,
        el('span', { className: 'spacer' }), dirty, said,
        save, validate, exportBtn, importBtn, close);

    return {
        node, name, dirty, said, save, undo, redo,
        // The canvas exists only once litegraph has loaded, so the buttons are
        // wired then rather than when they are built.
        wire(canvas, on) {
            save.onclick = on.save;
            close.onclick = on.close;
            validate.onclick = on.validate;
            exportBtn.onclick = on.exportElx;
            importBtn.onclick = on.importElx;
            undo.onclick = () => canvas.undo();
            redo.onclick = () => canvas.redo();
            relayout.onclick = () => canvas.relayout();
        },
    };
}
