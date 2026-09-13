// landpeople.js — who may touch this land, and how many of them have to say
// yes. Split out of landui.js when the card outgrew four hundred lines; these
// are the two sections that are about people rather than about ground.
//
// Every decision is the database's: set_grant, revoke_grant and
// set_required_approvals are what RLS reads afterwards (Invariant 6).

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const short = (id) => String(id ?? '').slice(0, 8).toUpperCase();

// What a grant is called on screen. The column says `edit`; the design, and
// everything the panel explains below, says Propose.
const RIGHT_WORDS = {
    edit: 'Propose', direct_edit: 'Direct edit', approve: 'Approve',
};

export function approvals(area, ctx) {
    const n = Number(area.rules?.required_approvals ?? 1);
    const value = el('span', { className: 'v', textContent: String(n) });
    const step = async (to) => {
        try {
            await ctx.api.rpc('set_required_approvals',
                { area_id: area.id, approvals: Math.max(0, to) });
            area.rules = { ...(area.rules ?? {}), required_approvals: Math.max(0, to) };
            value.textContent = String(Math.max(0, to));
            ctx.say(to === 0
                ? 'nobody has to approve: a rendered tile publishes itself'
                : `${to} approval${to === 1 ? '' : 's'} before a tile publishes`);
        } catch (err) {
            ctx.say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
    const less = el('button', { type: 'button', textContent: '−' });
    const more = el('button', { type: 'button', textContent: '+' });
    less.onclick = () => step(n - 1);
    more.onclick = () => step(n + 1);
    return el('div', { className: 'section' },
        el('div', { className: 'spread' },
            el('span', { className: 'label',
                textContent: 'Approvals needed to publish' }),
            area.mine ? el('div', { className: 'stepper' }, less, value, more)
                : el('span', { className: 'chip', 'data-tone': 'dim',
                    textContent: String(n) })),
        el('div', { className: 'note',
            textContent: n === 0
                ? 'Nobody reviews: what a direct editor renders is published.'
                : `Any ${n} of this land's approvers publishes a rendered tile.`
                  + ' Set it to 0 and direct editors publish without review.' }));
}

// Who else may work here, and the one control that adds somebody.
export function people(area, state, ctx) {
    const rows = el('ul', { className: 'rows' });
    rows.replaceChildren(...(state.grants ?? []).map((g) => el('li', {},
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: g.email ?? short(g.grantee_id) }),
            el('div', { className: 'sub', textContent: short(g.grantee_id) })),
        el('div', { className: 'end' },
            el('span', { className: 'role', style: 'color: var(--warn)',
                textContent: RIGHT_WORDS[g.right_ ?? g.right] ?? 'unknown' }),
            area.mine ? drop(area, g, ctx) : null))));
    if (!(state.grants ?? []).length) {
        rows.append(el('li', { className: 'muted',
            textContent: 'Nobody else may touch this land.' }));
    }
    return el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'People on this land' }),
        rows,
        area.mine ? give(area, ctx) : null,
        el('div', { className: 'note',
            textContent: 'Propose places candidates that need approval · '
                + 'Direct edit publishes without it · Approve decides on them.' }));
}

function drop(area, g, ctx) {
    const b = el('button', { type: 'button', textContent: 'revoke' });
    b.onclick = async () => {
        try {
            await ctx.api.rpc('revoke_grant', {
                area_id: area.id, grantee: g.grantee_id ?? g.email,
                right: g.right_ ?? g.right,
            });
            ctx.say('revoked');
            await ctx.refresh();
        } catch (err) {
            ctx.say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
    return b;
}

function give(area, ctx) {
    const who = el('input', { type: 'email', placeholder: 'email' });
    const what = el('select', {});
    for (const [v, t] of [['edit', 'Propose'], ['direct_edit', 'Direct edit'],
        ['approve', 'Approve']]) {
        what.append(el('option', { value: v, textContent: t }));
    }
    const add = el('button', { type: 'button', textContent: 'Grant' });
    add.onclick = async () => {
        try {
            await ctx.api.rpc('set_grant', {
                area_id: area.id, email: who.value, right: what.value,
            });
            who.value = '';
            ctx.say('granted');
            await ctx.refresh();
        } catch (err) {
            ctx.say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
    return el('div', { className: 'row' }, who, what, add);
}

// What somebody has put here for a decision.
