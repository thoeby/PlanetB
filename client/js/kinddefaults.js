// kinddefaults.js — what a kind is when nobody says otherwise, in the
// Vocabulary panel (EDT.23, db/0199): its width, whether it runs straight
// between nodes, the steepest it should climb, and whether the pickers in
// Build → Lines and Survey → Areas offer it. A blank field is the editors'
// own guess (client/lib/kinds.js), shown as its placeholder.

import * as api from './api.js';
import { guessOf } from '../lib/kinds.js';

export const DEFAULTS_HTML = `
<div class="row vo-defaults">
  <label>Width (m)<input class="vo-width" type="number" min="0.1" max="100" step="0.1"></label>
  <label>Steepest (%)<input class="vo-gradient" type="number" min="1" max="1000"></label>
  <label>Corners<select class="vo-corner">
    <option value="">the editors' guess</option>
    <option value="curved">curved</option>
    <option value="cornered">straight between nodes</option>
  </select></label>
  <label class="vo-check"><input class="vo-hidden" type="checkbox">Hidden from the pickers</label>
</div>
<p class="note">What Build → Lines and Survey → Areas offer for this kind. A blank
  field is the editors' own guess.</p>`;

export const loadDefaults = async () => new Map(
    ((await api.select('kind_default').catch(() => [])) ?? []).map((r) => [r.kind, r]));

export function fillDefaults(q, kind, row) {
    const guess = guessOf(kind?.name);
    q('.vo-width').value = row?.width ?? '';
    q('.vo-width').placeholder = String(guess.width);
    q('.vo-gradient').value = row?.gradient ?? '';
    q('.vo-gradient').placeholder = String(guess.gradient);
    q('.vo-corner').value = row?.corner == null ? '' : row.corner ? 'cornered' : 'curved';
    q('.vo-hidden').checked = Boolean(row?.hidden);
}

// The fields as put_kind_default's arguments, or null when there is nothing
// to say and nothing said before.
export function defaultsOf(q, kind, row) {
    const num = (sel) => (q(sel).value === '' ? null : Number(q(sel).value));
    const corner = q('.vo-corner').value;
    const args = { kind: kind.name, width: num('.vo-width'), gradient: num('.vo-gradient'),
        corner: corner === '' ? null : corner === 'cornered', hidden: q('.vo-hidden').checked };
    const empty = args.width == null && args.gradient == null && args.corner == null
        && !args.hidden;
    return empty && !row ? null : args;
}
