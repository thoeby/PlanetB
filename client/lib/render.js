// render.js — a small forward renderer over WebGL2, for the frame atom.
//
// The scene is our own: per-vertex colour, one directional light and an ambient
// term, no textures and no shadows. Everything a frame has to show was already
// decided by `assemble`; this only has to show it the same way twice, on every
// machine that renders the same range (WP2.4's PSNR check).
//
// It runs on an OffscreenCanvas inside a Web Worker, which is where atoms live.

import { perspective, viewMatrix } from './cameras.js';

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vNormal;
out vec3 vColor;
void main() {
    vNormal = aNormal;
    vColor = aColor;
    gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

// A fixed sun, so two workers light the same triangle the same way.
const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
out vec4 outColor;
const vec3 SUN = normalize(vec3(0.42, 0.83, 0.36));
void main() {
    float d = max(dot(normalize(vNormal), SUN), 0.0);
    // The ortho arrives already display-encoded, so this shades it rather than
    // lighting it: no second gamma, and a floor so nothing goes to black.
    vec3 lit = vColor * (0.55 + 0.55 * d);
    outColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
}

export class Renderer {
    constructor(canvas, size) {
        this.size = size;
        this.gl = canvas.getContext('webgl2', {
            antialias: false, preserveDrawingBuffer: true, alpha: false, depth: true,
        });
        if (!this.gl) throw new Error('no webgl2 context for the frame atom');
        const gl = this.gl;
        this.program = gl.createProgram();
        gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.bindAttribLocation(this.program, 0, 'aPos');
        gl.bindAttribLocation(this.program, 1, 'aNormal');
        gl.bindAttribLocation(this.program, 2, 'aColor');
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error(`link: ${gl.getProgramInfoLog(this.program)}`);
        }
        gl.useProgram(this.program);
        this.uView = gl.getUniformLocation(this.program, 'uView');
        this.uProj = gl.getUniformLocation(this.program, 'uProj');
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.viewport(0, 0, size, size);
        this.batches = [];
    }

    // meshes: what lib/mesh.js unpacked — plain typed arrays.
    upload(meshes) {
        const gl = this.gl;
        for (const m of meshes) {
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            const attr = (loc, data, n) => {
                const b = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, b);
                gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
            };
            attr(0, m.positions, 3);
            attr(1, m.normals, 3);
            attr(2, m.colors, 3);
            const idx = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
            gl.bindVertexArray(null);
            this.batches.push({ vao, count: m.indices.length });
        }
    }

    // Returns the frame top-down, RGBA, ready for an ImageData.
    draw(cam, { near = 0.5, far = 20000 } = {}) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.clearColor(0.55, 0.68, 0.85, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(this.uView, false, viewMatrix(cam));
        gl.uniformMatrix4fv(this.uProj, false, perspective(cam.fov, 1, near, far));
        for (const b of this.batches) {
            gl.bindVertexArray(b.vao);
            gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
        }
        gl.bindVertexArray(null);
        const n = this.size;
        const pixels = new Uint8Array(n * n * 4);
        gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return flip(pixels, n);
    }
}

// readPixels counts rows from the bottom; every image format counts from the top.
function flip(pixels, n) {
    const out = new Uint8ClampedArray(pixels.length);
    const row = n * 4;
    for (let y = 0; y < n; y++) {
        out.set(pixels.subarray((n - 1 - y) * row, (n - y) * row), y * row);
    }
    return out;
}

// The browser's own WebP encoder, through a 2D canvas: a worker has no other.
export async function toWebp(rgba, size, canvas, quality = 0.9) {
    const c = canvas(size, size);
    c.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality });
    return new Uint8Array(await blob.arrayBuffer());
}

export function psnr(a, b) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
        if (i % 4 === 3) continue;                 // alpha is always opaque here
        const d = a[i] - b[i];
        sum += d * d;
        n += 1;
    }
    const mse = sum / n;
    return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}
