// hudbar.js — what the top bar holds besides the views (TASKS-ui.md UI.1).
//
// The middle of the bar is one slot with three possible tenants: where you are
// standing (the compass and the place line) in a view that is the world, the
// tabs of a workspace that has the window, or a workspace's own tabs where it
// is not a surface of the chrome (Automate). The left end holds undo and redo
// for whatever is being edited. And whether the views are glyphs on the bar or
// cards in the drawer is measured, not guessed: the bar is laid out with the
// glyphs, and if it does not fit they fold away.

// What the bar's three parts need, side by side. Each end may shrink below
// what it holds and spill over the middle rather than scroll, so the bar's
// own scrollWidth does not see it; the parts' own widths do.
const needs = (top) => [...top.children].reduce((n, c) => n + c.scrollWidth, 0);
const over = (top) => needs(top) > top.clientWidth + 1;

// The views fold into the drawer when the bar, laid out with them, is wider
// than the window; if it still is, the clock and the words beside the
// profile and the waiting count go (`data-tight`). Measured from the widest
// layout every time, so it can also unfold.
export function fitBar(top) {
    top.dataset.fold = '';
    top.dataset.tight = '';
    if (!over(top)) return true;
    top.dataset.fold = '1';
    if (over(top)) top.dataset.tight = '1';
    return false;
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
