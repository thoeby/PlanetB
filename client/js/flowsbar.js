// flowsbar.js — the one bar over the Automate view (design 10a).
//
// Split out of flowsui.js only for size. On the left, which flow is open and
// where it lives, whether anything is unsaved and what the view last had to
// say; on the right the Server control, auto-layout and the actions
// (TASKS-ui.md UI.8). Undo and redo are the top bar's (hud.edits), and the
// view's four tabs are in the top bar too. What belongs to the Editor alone is
// marked `fl-ed`, and hidden on the other pages.

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
    const name = el('span', { className: 'name fl-ed', textContent: 'Flows' });
    const where = el('span', { className: 'fl-where fl-ed' });
    const dirty = el('span', { className: 'fl-dirty fl-ed' }, el('i'), 'unsaved');
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
    const relayout = button('fl-layout fl-ed', 'Auto-layout', { key: 'L' });
    const close = button('fl-close', 'Close · Esc', { label: 'Close' });
    // FL.1: which process server the view talks to (serverpicker.js).
    const server = el('span', { className: 'fl-srv' });
    for (const b of [save, keep, validate, send, run, exportBtn]) b.classList.add('fl-ed');
    ro.classList.add('fl-ed');
    const node = el('div', { className: 'fl-top' },
        name, where, dirty, el('span', { className: 'spacer' }, said),
        server, relayout, sep(),
        el('span', { className: 'fl-group fl-acts-top' },
            ro, save, keep, validate, send, run, exportBtn, importBtn, sep(), close));

    return {
        node, name, where, dirty, said, save, server, send, run, ro, keep,
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
            relayout.onclick = () => canvas.relayout();
        },
    };
}
