// buildrows.js — the two lists of the Build panel: the products you may place,
// and the tiles your edits have made dirty.
//
// Split out of buildui.js for size (CLAUDE.md). Plain DOM, no decisions.

import { portWords } from '../lib/marks.js';

export function assetRow(asset, onPick) {
    const li = document.createElement('li');
    li.className = 'build-asset';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${asset.name} · ${asset.san}`;
    b.onclick = () => onPick(asset);
    li.append(b);
    // FND.6: a product with live parts says what one of them can be told,
    // because that is the difference between this lamp and the one beside it.
    const ports = portWords(asset.parts);
    if (ports) {
        const said = document.createElement('span');
        said.className = 'muted build-ports';
        said.textContent = ` ports: ${ports}`;
        li.append(said);
    }
    return li;
}

export function tileRow(t, onRender) {
    const li = document.createElement('li');
    li.className = 'build-tile';
    li.textContent = `${t.z}/${t.x}/${t.y} v${t.expected_version}${t.dirty ? ' dirty' : ''} `;
    if (t.dirty) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.job_id ? `job ${t.job_id}` : 'render now';
        b.onclick = () => onRender(t, b);
        li.append(b);
    }
    return li;
}
