// flowpages.js — Automate's four pages and the tabs for them (TASKS-ui.md UI.8).
//
// Flows is where Automate opens: every flow of yours as a card. Editor is the
// columns that were the whole view — the list, the blocks, the canvas, the
// inspector. Schedule is the Planner, the jobs of the chosen server on a
// timeline. Paths draws a route for a product to drive. The tabs are lent to
// the top bar while Automate is open (hud.barTabs), the way a workspace's
// parts are, and the view's own bar keeps the Server control for all four.

import { el } from './poolui.js';

export const PAGES = ['Flows', 'Editor', 'Schedule', 'Paths'];

export function mountPages(root, { onPage } = {}) {
    const nav = el('nav', { className: 'parts fl-pages' });
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Automate');
    const buttons = new Map();
    for (const name of PAGES) {
        const b = el('button', { type: 'button', className: 'part', textContent: name });
        b.dataset.tab = name;
        b.setAttribute('role', 'tab');
        b.onclick = () => go(name);
        buttons.set(name, b);
        nav.append(b);
    }
    const page = (cls) => {
        const n = el('div', { className: `fl-page ${cls}` });
        root.append(n);
        return n;
    };
    const home = page('fl-home');
    const sched = page('fl-sched');
    const paths = page('fl-paths');
    let at = null;
    function go(name) {
        const was = at;
        at = name;
        root.dataset.page = name.toLowerCase();
        for (const [n, b] of buttons) b.setAttribute('aria-selected', String(n === name));
        if (was !== name) onPage?.(name, was);
    }
    return { nav, home, sched, paths, go, at: () => at };
}
