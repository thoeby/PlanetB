// empty.js — what a panel says when there is nothing in it yet.
//
// It is the first thing most people see on most surfaces, and a grey sentence
// in the middle of black reads as a page that failed rather than as a page
// waiting. So an empty state has a shape: what would be here, said in the
// panel's own voice, and — where there is one — the move that puts something
// in it. panel.css draws it.

export function empty(head, said, { as = 'div', act = null, onAct = null } = {}) {
    const node = document.createElement(as);
    node.className = 'empty';
    node.append(Object.assign(document.createElement('b'), { textContent: head }));
    if (said) node.append(Object.assign(document.createElement('span'), { textContent: said }));
    if (act) {
        const b = Object.assign(document.createElement('button'),
            { type: 'button', textContent: act });
        b.onclick = () => onAct?.();
        node.append(b);
    }
    return node;
}
