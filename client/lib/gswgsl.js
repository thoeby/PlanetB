// gswgsl.js — the forward half of the trainer, as WGSL.
//
// Line for line the same arithmetic as client/lib/gsmath.js and
// client/lib/gsrast.js. client/test/e2e/gsgpu.spec.js renders the same scene
// through both and compares them, which is the only thing keeping the two
// honest; change one and change the other.
//
// Layout of `pre`, 24 floats per gaussian:
//   0 u  1 v  2 depth  3 radius   4..6 conic  7 opacity
//   8..10 cov(a,b,c)  11 visible  12..17 T (two rows)  18..20 camera-space
//   21..23 colour

export const TILE = 16;
export const STRIDE = 24;
export const SH_C0 = 0.28209479177387814;

export const COMMON = `
struct Cam {
  w0: vec3f, fx: f32,
  w1: vec3f, fy: f32,
  w2: vec3f, cx: f32,
  tr: vec3f, cy: f32,
  dims: vec4u,      // width, height, tilesX, count
  misc: vec4f,      // near, capacity, lrScale, targetBase
};
struct Cov3 { a: vec3f, b: vec3f };

const TILE: u32 = ${TILE}u;
const STRIDE: u32 = ${STRIDE}u;
const BLUR: f32 = 0.3;
const CUTOFF: f32 = 3.0;
const SKY: vec3f = vec3f(0.55, 0.68, 0.85);
const MIN_ALPHA: f32 = 1.0 / 255.0;
const MAX_ALPHA: f32 = 0.99;
const STOP: f32 = 1e-4;

fn covOf(s: vec3f, q: vec4f) -> Cov3 {
  let n = max(length(q), 1e-12);
  let w = q.x / n; let x = q.y / n; let y = q.z / n; let z = q.w / n;
  let m0 = vec3f((1.0 - 2.0 * (y * y + z * z)) * s.x, (2.0 * (x * y - w * z)) * s.y,
                 (2.0 * (x * z + w * y)) * s.z);
  let m1 = vec3f((2.0 * (x * y + w * z)) * s.x, (1.0 - 2.0 * (x * x + z * z)) * s.y,
                 (2.0 * (y * z - w * x)) * s.z);
  let m2 = vec3f((2.0 * (x * z - w * y)) * s.x, (2.0 * (y * z + w * x)) * s.y,
                 (1.0 - 2.0 * (x * x + y * y)) * s.z);
  return Cov3(vec3f(dot(m0, m0), dot(m0, m1), dot(m0, m2)),
              vec3f(dot(m1, m1), dot(m1, m2), dot(m2, m2)));
}

fn sigmoid(v: f32) -> f32 { return 1.0 / (1.0 + exp(-v)); }
`;

// Every gaussian, once per view: where it lands, how wide, and which tiles it
// touches. A tile list is filled by atomic bump; the order is sorted after.
export const PREPROCESS = `
@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> logScale: array<f32>;
@group(0) @binding(2) var<storage, read> quat: array<f32>;
@group(0) @binding(3) var<storage, read> sh: array<f32>;
@group(0) @binding(4) var<storage, read> logit: array<f32>;
@group(0) @binding(5) var<storage, read_write> pre: array<f32>;
@group(0) @binding(6) var<storage, read_write> tileCount: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> tileItems: array<u32>;
@group(0) @binding(8) var<uniform> cam: Cam;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= cam.dims.w) { return; }
  let base = i * STRIDE;
  pre[base + 11] = 0.0;
  let p = vec3f(pos[i * 3u], pos[i * 3u + 1u], pos[i * 3u + 2u]);
  let c = vec3f(dot(cam.w0, p), dot(cam.w1, p), dot(cam.w2, p)) + cam.tr;
  let d = -c.z;
  if (d < cam.misc.x) { return; }
  let s = exp(vec3f(logScale[i * 3u], logScale[i * 3u + 1u], logScale[i * 3u + 2u]));
  let sig = covOf(s, vec4f(quat[i * 4u], quat[i * 4u + 1u], quat[i * 4u + 2u],
                           quat[i * 4u + 3u]));
  let j0 = vec3f(cam.fx / d, 0.0, cam.fx * c.x / (d * d));
  let j1 = vec3f(0.0, -cam.fy / d, -cam.fy * c.y / (d * d));
  let t0 = j0.x * cam.w0 + j0.y * cam.w1 + j0.z * cam.w2;
  let t1 = j1.x * cam.w0 + j1.y * cam.w1 + j1.z * cam.w2;
  let s0 = vec3f(sig.a.x, sig.a.y, sig.a.z);
  let s1 = vec3f(sig.a.y, sig.b.x, sig.b.y);
  let s2 = vec3f(sig.a.z, sig.b.y, sig.b.z);
  let st0 = vec3f(dot(s0, t0), dot(s1, t0), dot(s2, t0));
  let st1 = vec3f(dot(s0, t1), dot(s1, t1), dot(s2, t1));
  let ca = dot(t0, st0) + BLUR;
  let cb = dot(t0, st1);
  let cc = dot(t1, st1) + BLUR;
  let det = ca * cc - cb * cb;
  if (!(det > 1e-12)) { return; }
  let u = cam.cx + cam.fx * c.x / d;
  let v = cam.cy - cam.fy * c.y / d;
  let mid = (ca + cc) * 0.5;
  let off = sqrt(max(0.01, mid * mid - det));
  let radius = ceil(CUTOFF * sqrt(mid + off));
  if (u + radius < 0.0 || u - radius >= f32(cam.dims.x)
      || v + radius < 0.0 || v - radius >= f32(cam.dims.y)) { return; }
  pre[base] = u; pre[base + 1u] = v; pre[base + 2u] = d; pre[base + 3u] = radius;
  pre[base + 4u] = cc / det; pre[base + 5u] = -cb / det; pre[base + 6u] = ca / det;
  pre[base + 7u] = sigmoid(logit[i]);
  pre[base + 8u] = ca; pre[base + 9u] = cb; pre[base + 10u] = cc;
  pre[base + 11u] = 1.0;
  pre[base + 12u] = t0.x; pre[base + 13u] = t0.y; pre[base + 14u] = t0.z;
  pre[base + 15u] = t1.x; pre[base + 16u] = t1.y; pre[base + 17u] = t1.z;
  pre[base + 18u] = c.x; pre[base + 19u] = c.y; pre[base + 20u] = c.z;
  pre[base + 21u] = 0.5 + ${SH_C0} * sh[i * 3u];
  pre[base + 22u] = 0.5 + ${SH_C0} * sh[i * 3u + 1u];
  pre[base + 23u] = 0.5 + ${SH_C0} * sh[i * 3u + 2u];
  scatter(i, u, v, radius);
}

fn scatter(i: u32, u: f32, v: f32, radius: f32) {
  let tx = cam.dims.z;
  let ty = (cam.dims.y + TILE - 1u) / TILE;
  let cap = u32(cam.misc.y);
  let x0 = u32(max(0.0, floor((u - radius) / f32(TILE))));
  let x1 = u32(max(0.0, min(f32(tx) - 1.0, floor((u + radius) / f32(TILE)))));
  let y0 = u32(max(0.0, floor((v - radius) / f32(TILE))));
  let y1 = u32(max(0.0, min(f32(ty) - 1.0, floor((v + radius) / f32(TILE)))));
  if (u + radius < 0.0 || v + radius < 0.0) { return; }
  for (var y = y0; y <= y1 && y < ty; y++) {
    for (var x = x0; x <= x1 && x < tx; x++) {
      let t = y * tx + x;
      let slot = atomicAdd(&tileCount[t], 1u);
      if (slot < cap) { tileItems[t * cap + slot] = i; }
    }
  }
}
`;

// A tile's list, in depth order. Bitonic in workgroup memory, over the next
// power of two at or above what the tile actually holds — an empty tile costs
// two barriers, not the whole network, and most tiles are nearly empty.
//
// The size has to be *uniform* across the workgroup or WGSL will not allow a
// barrier inside the loop, and a count read from a storage buffer is not.
// workgroupUniformLoad is what makes it one: thread zero works it out, and the
// load barriers and hands back a value the compiler knows every thread agrees
// on.
export const SORT = `
@group(0) @binding(0) var<storage, read> pre: array<f32>;
@group(0) @binding(1) var<storage, read_write> tileCount: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> tileItems: array<u32>;
@group(0) @binding(3) var<uniform> cam: Cam;

const CAP: u32 = ${'${CAP}'}u;
var<workgroup> keyDepth: array<f32, CAP>;
var<workgroup> keyIdx: array<u32, CAP>;
var<workgroup> span: array<u32, 2>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let tile = wg.x;
  let cap = u32(cam.misc.y);
  if (li == 0u) {
    var held = atomicLoad(&tileCount[tile]);
    if (held > cap) { held = cap; atomicStore(&tileCount[tile], cap); }
    var wide = 0u;
    if (held >= 2u) {
      wide = 2u;
      loop { if (wide >= held) { break; } wide <<= 1u; }
    }
    span[0] = held;
    span[1] = wide;
  }
  let n = workgroupUniformLoad(&span[0]);
  let m = workgroupUniformLoad(&span[1]);
  for (var k = li; k < m; k += 256u) {
    if (k < n) {
      let g = tileItems[tile * cap + k];
      keyIdx[k] = g;
      keyDepth[k] = pre[g * STRIDE + 2u];
    } else {
      keyIdx[k] = 0u;
      keyDepth[k] = 3.4e38;
    }
  }
  workgroupBarrier();
  for (var size = 2u; size <= m; size <<= 1u) {
    for (var step = size >> 1u; step > 0u; step >>= 1u) {
      for (var t = li; t < m / 2u; t += 256u) {
        let low = (t & (step - 1u)) | ((t & ~(step - 1u)) << 1u);
        let high = low | step;
        let up = (low & size) == 0u;
        if ((keyDepth[low] > keyDepth[high]) == up) {
          let d = keyDepth[low]; keyDepth[low] = keyDepth[high]; keyDepth[high] = d;
          let g = keyIdx[low]; keyIdx[low] = keyIdx[high]; keyIdx[high] = g;
        }
      }
      workgroupBarrier();
    }
  }
  for (var k = li; k < m; k += 256u) {
    if (k < n) { tileItems[tile * cap + k] = keyIdx[k]; }
  }
}
`;

// One thread per pixel, front to back over its own tile's list.
export const RENDER = `
@group(0) @binding(0) var<storage, read> pre: array<f32>;
@group(0) @binding(1) var<storage, read> tileCount: array<u32>;
@group(0) @binding(2) var<storage, read> tileItems: array<u32>;
@group(0) @binding(3) var<storage, read_write> image: array<f32>;
@group(0) @binding(4) var<storage, read_write> rest: array<f32>;
@group(0) @binding(5) var<storage, read_write> last: array<u32>;
@group(0) @binding(6) var<uniform> cam: Cam;

@compute @workgroup_size(${TILE}, ${TILE})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lo: vec3u) {
  let px = wg.x * TILE + lo.x;
  let py = wg.y * TILE + lo.y;
  let tile = wg.y * cam.dims.z + wg.x;
  let cap = u32(cam.misc.y);
  let n = min(tileCount[tile], cap);
  var t = 1.0;
  var acc = vec3f(0.0);
  var contributed = 0u;
  let p = vec2f(f32(px) + 0.5, f32(py) + 0.5);
  for (var k = 0u; k < n; k++) {
    let g = tileItems[tile * cap + k] * STRIDE;
    let d = p - vec2f(pre[g], pre[g + 1u]);
    let power = -0.5 * (pre[g + 4u] * d.x * d.x + pre[g + 6u] * d.y * d.y)
                - pre[g + 5u] * d.x * d.y;
    if (power > 0.0) { continue; }
    let alpha = min(MAX_ALPHA, pre[g + 7u] * exp(power));
    if (alpha < MIN_ALPHA) { continue; }
    if (t * (1.0 - alpha) < STOP) { break; }
    acc += vec3f(pre[g + 21u], pre[g + 22u], pre[g + 23u]) * alpha * t;
    t *= 1.0 - alpha;
    contributed = k + 1u;
  }
  if (px >= cam.dims.x || py >= cam.dims.y) { return; }
  let at = py * cam.dims.x + px;
  let out = acc + SKY * t;
  image[at * 3u] = out.x; image[at * 3u + 1u] = out.y; image[at * 3u + 2u] = out.z;
  rest[at] = t;
  last[at] = contributed;
}
`;
