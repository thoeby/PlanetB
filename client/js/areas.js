// areas.js — who may change what, and what they have asked to change.
//
// An area's owner grants `direct_edit`, `edit` or `approve`. A writer changes
// the world; a proposer's change becomes a proposal that an approver merges.
// None of that is decided here: `propose` and `approve` are ordinary invoker
// functions behind the policies in db/0003_rls.sql, `merge_proposal` checks the
// area's authority itself, and this file only asks (Invariant 6).

import * as api from './api.js';

export const RIGHTS = ['direct_edit', 'edit', 'approve'];

export const myAreas = () => api.rpc('my_areas');
export const areaGrants = (areaId) => api.rpc('area_grants', { area_id: areaId });
export const myProposals = (state = 'open') => api.rpc('my_proposals', { state });

export const grant = (areaId, email, right) =>
    api.rpc('set_grant', { area_id: areaId, email, right_: right });
export const revoke = (areaId, granteeId, right) =>
    api.rpc('revoke_grant', { area_id: areaId, grantee_id: granteeId, right_: right });
export const setRequiredApprovals = (areaId, n) =>
    api.rpc('set_required_approvals', { area_id: areaId, n });

export const propose = (areaId, diff) => api.rpc('propose', { area_id: areaId, diff });
export const approve = (proposalId) => api.rpc('approve', { proposal_id: proposalId });
export const merge = (proposalId) => api.rpc('merge_proposal', { proposal_id: proposalId });

// ---------------------------------------------------------------- the diff

// The shape db/0022_proposals.sql applies, built here so build mode and the
// area panel agree about it. Ops are applied in array order.
export const insertOp = (table, values) => ({ op: 'insert', table, values });
export const updateOp = (table, id, values) => ({ op: 'update', table, id, values });
export const deleteOp = (table, id) => ({ op: 'delete', table, id });

export const diffOf = (...ops) => ({ ops: ops.flat().filter(Boolean) });

// A placement, as a proposal rather than a write. Same columns build.js would
// have inserted — an `edit` grantee's placement is the same change, waiting.
export function placementDiff(san, at, pose = {}) {
    return diffOf(insertOp('instance', {
        san, lon: at.lon, lat: at.lat, h: at.h ?? 0,
        yaw: pose.yaw ?? 0, pitch: pose.pitch ?? 0, roll: pose.roll ?? 0,
        scale: pose.scale ?? 1,
    }));
}

// What a diff says, in one line per op, for a panel that has to show it before
// anyone approves it. Never trusted for anything but reading.
export function describeDiff(diff) {
    return (diff?.ops ?? []).map((op) => {
        const what = op.table === 'instance'
            ? (op.values?.san ?? op.id ?? '?')
            : (op.values?.kind ?? op.id ?? '?');
        const where = op.values?.lon !== undefined
            ? ` at ${Number(op.values.lon).toFixed(5)}, ${Number(op.values.lat).toFixed(5)}`
            : '';
        return `${op.op} ${op.table} ${what}${where}`;
    });
}
