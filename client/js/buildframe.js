// buildframe.js — picking a product to place puts it in view (UI.3).
//
// A crate is half a metre and a bus is twelve, and a camera that stays at eye
// height two paces back shows one as a speck and the other as a wall. Picking
// a product therefore moves the camera to look down at the ground ahead from a
// distance that fits the product's size — the spot it would land on is in the
// middle of the view — and switches to flying, so the height sticks.

import { FLY } from './player.js';

const PITCH_DEG = 35;

// The largest side of a product, from the box canon measured (metres).
export function sizeOf(bbox) {
    if (!bbox?.min || !bbox?.max) return 2;
    return Math.max(0.2, ...bbox.max.map((v, i) => Math.abs(v - bbox.min[i])));
}

// How far from the spot to stand, and how high: pure, so it can be tested.
export function framing(size) {
    const d = Math.min(80, Math.max(4, size * 2.5));
    const a = (PITCH_DEG * Math.PI) / 180;
    return { d, back: d * Math.cos(a), up: d * Math.sin(a), pitch: -a };
}

export function frameFor({ player, terrain }, asset) {
    if (!player) return null;
    const f = framing(sizeOf(asset?.bbox));
    const p = player.position;
    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const spot = { x: p.x + fwd.x * f.d, z: p.z + fwd.z * f.d };
    const ground = terrain?.heightAt({ x: spot.x, y: p.y, z: spot.z })
        ?? p.y - (player.eye ?? 1.7);
    if (player.mode !== FLY) player.toggleMode();
    player.position = { x: spot.x - fwd.x * f.back, y: ground + f.up,
        z: spot.z - fwd.z * f.back };
    player.pitch = f.pitch;
    return { spot: { ...spot, y: ground }, ...f };
}
