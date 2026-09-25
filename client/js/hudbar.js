// hudbar.js — what the top bar holds besides the views (TASKS-ui.md UI.1).
//
// The middle of the bar is one slot with three possible tenants: where you are
// standing (the compass and the place line) in a view that is the world, the
// tabs of a workspace that has the window, or a workspace's own tabs where it
// is not a surface of the chrome (Automate). The left end holds undo and redo
// for whatever is being edited. And whether the views are glyphs on the bar or
// cards in the drawer is measured, not guessed: the bar is laid out with the
// glyphs, and if it does not fit they fold away.

// Whether an end of the bar holds what it is given. The two ends are equal
// columns either side of the middle (top.css), and the right one is aligned
// right, so what it cannot hold spills out on its left, where scrollWidth
// does not count it: its children are added up instead.
const spills = (end) => end
    && [...end.children].reduce((n, k) => n + k.offsetWidth, 0) > end.clientWidth + 1;

// Measured from the widest layout every time, so it can also unfold. The
// views fold into the drawer when the left end cannot hold their glyphs; the
// right end sheds words first (`data-tight` 1: the clock, the names beside
// the numbers, the coordinates in the middle) and then the world's two
// numbers (2).
export function fitBar(top) {
    const [left, , right] = top.children;
    top.dataset.fold = '';
    top.dataset.tight = '';
    if (spills(left)) top.dataset.fold = '1';
    if (spills(right)) top.dataset.tight = '1';
    if (spills(right)) top.dataset.tight = '2';
    return !top.dataset.fold && !top.dataset.tight;
}

export function watchFit(top) {
    const again = () => fitBar(top);
    globalThis.addEventListener?.('resize', again);
    // The ends grow when what they hold does (a name signed in, a count
    // appearing), which the bar itself, as wide as the window, never does.
    if (typeof ResizeObserver === 'function') {
        const watch = new ResizeObserver(again);
        for (const n of [top, ...top.children]) watch.observe(n);
    }
    again();
    return again;
}

// Who is in the middle of the bar: the place line, a workspace's tabs, or a
// view's own. Nodes are moved, never rebuilt — the stories and the modules
// hold on to them.
export function centreSlot(centre, where) {
    let own = null;
    return {
        // `parts` is the chrome's tab strip when a workspace has the window,
        // or null; `world` whether the view is one you stand in.
        show({ parts = null, world = true } = {}) {
            const tenant = own ?? parts ?? (world ? where : null);
            for (const child of [...centre.children]) {
                if (child !== tenant) child.remove();
            }
            if (tenant && tenant.parentNode !== centre) centre.append(tenant);
            centre.dataset.holds = tenant === where ? 'where' : tenant ? 'tabs' : '';
        },
        // A workspace that draws its own tabs (Automate) lends them here while
        // it is open, and takes them back with null.
        lend(node) { own = node; },
    };
}

// Undo and redo on the bar, for whoever is editing now. Each editor registers
// under its own key — `use(key, on)`, on = { undo, redo, canUndo, canRedo,
// live } or null — and the first one whose `live()` says it is on screen has
// the two buttons; with none, they are not drawn. `changed()` asks again,
// after an edit or when a panel opens.
export function editSlot(edit) {
    const users = new Map();
    const now = () => [...users.values()].find((on) => on && (on.live?.() ?? true)) ?? null;
    const draw = () => {
        const on = now();
        edit.node.hidden = !on;
        edit.undo.disabled = !on?.canUndo?.();
        edit.redo.disabled = !on?.canRedo?.();
    };
    edit.undo.onclick = () => { now()?.undo?.(); draw(); };
    edit.redo.onclick = () => { now()?.redo?.(); draw(); };
    draw();
    return {
        use(key, on) {
            if (on) users.set(key, on); else users.delete(key);
            draw();
        },
        changed: draw,
        using: now,
    };
}
