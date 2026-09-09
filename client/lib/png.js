// png.js — the only image codec canon-v1 owns.
//
// A canonical GLB may not depend on a platform encoder: two browsers disagree
// on the bytes a canvas produces (WP2's deviation 39), and a SAN that changed
// with the machine would fracture the catalog. So the one image the canon ever
// writes — a texture it had to shrink — is PNG, filtered flat and deflated as
// stored blocks. No compression choices, no entropy coder, same bytes anywhere.
//
// Textures that are already within budget are passed through untouched, so this
// runs rarely; `imageInfo` is what runs on every upload.

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

// -------------------------------------------------------------------- sniffing

// { mime, width, height } for the three formats a GLB may carry. Nothing here
// decodes: a canon only needs the size to decide whether to resize.
export function imageInfo(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (PNG_SIG.every((b, i) => bytes[i] === b)) {
        return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(dv, bytes);
    if (dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
        return webpInfo(dv, bytes);
    }
    throw new Error('unknown image format in the GLB');
}

function jpegInfo(dv, bytes) {
    let at = 2;
    while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) { at += 1; continue; }
        const marker = bytes[at + 1];
        const len = dv.getUint16(at + 2);
        // SOF0..SOF15, minus the four that are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { mime: 'image/jpeg',
                height: dv.getUint16(at + 5), width: dv.getUint16(at + 7) };
        }
        at += 2 + len;
    }
    throw new Error('jpeg has no frame header');
}

function webpInfo(dv, bytes) {
    const fourcc = String.fromCharCode(...bytes.subarray(12, 16));
    if (fourcc === 'VP8X') {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { mime: 'image/webp', width: w, height: h };
    }
    if (fourcc === 'VP8L') {
        const b = dv.getUint32(21, true);
        return { mime: 'image/webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (fourcc === 'VP8 ') {
        return {
            mime: 'image/webp',
            width: dv.getUint16(26, true) & 0x3fff,
            height: dv.getUint16(28, true) & 0x3fff,
        };
    }
    throw new Error('unknown webp chunk ' + fourcc);
}

// --------------------------------------------------------------------- decode

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
}

function pngChunks(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    let at = 8;
    while (at + 8 <= bytes.length) {
        const len = dv.getUint32(at);
        out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
            body: bytes.subarray(at + 8, at + 8 + len) });
        at += 12 + len;
    }
    return out;
}

// 8-bit greyscale, RGB, greyscale+alpha or RGBA, non-interlaced — what an
// exporter writes. Anything else is refused rather than guessed at.
export async function decodePng(bytes) {
    const { width, height } = imageInfo(bytes);
    const chunks = pngChunks(bytes);
    const ihdr = chunks.find((c) => c.type === 'IHDR').body;
    const [depth, colorType, , , interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]];
    const ch = CHANNELS[colorType];
    if (depth !== 8 || !ch || interlace !== 0) {
        throw new Error(`unsupported png: depth ${depth}, colour type ${colorType}`);
    }
    const idat = chunks.filter((c) => c.type === 'IDAT');
    const packed = new Uint8Array(idat.reduce((n, c) => n + c.body.length, 0));
    let at = 0;
    for (const c of idat) { packed.set(c.body, at); at += c.body.length; }
    const rows = await unfilter(await inflate(packed), width, height, ch);
    return { width, height, data: toRgba(rows, width * height, ch) };
}

async function unfilter(raw, width, height, ch) {
    const stride = width * ch;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const type = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? out[y * stride + i - ch] : 0;
            const b = y > 0 ? out[(y - 1) * stride + i] : 0;
            const c = y > 0 && i >= ch ? out[(y - 1) * stride + i - ch] : 0;
            out[y * stride + i] = (src[i] + predict(type, a, b, c)) & 255;
        }
    }
    return out;
}

function predict(type, a, b, c) {
    if (type === 1) return a;
    if (type === 2) return b;
    if (type === 3) return (a + b) >> 1;
    if (type !== 4) return 0;
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

function toRgba(src, pixels, ch) {
    if (ch === 4) return src;
    const out = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
        const grey = ch <= 2;
        out[i * 4] = src[i * ch];
        out[i * 4 + 1] = grey ? src[i * ch] : src[i * ch + 1];
        out[i * 4 + 2] = grey ? src[i * ch] : src[i * ch + 2];
        out[i * 4 + 3] = ch === 2 ? src[i * ch + 1] : 255;
    }
    return out;
}

// --------------------------------------------------------------------- encode

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
}

// Deflate as stored blocks: no Huffman table, no match search, no choices —
// the same bytes on every machine, which is the whole point of this file.
function zlibStored(data) {
    const blocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    out[0] = 0x78;
    out[1] = 0x01;
    let at = 2;
    for (let i = 0; i < blocks; i++) {
        const part = data.subarray(i * 65535, Math.min((i + 1) * 65535, data.length));
        out[at] = i === blocks - 1 ? 1 : 0;
        out[at + 1] = part.length & 255;
        out[at + 2] = part.length >> 8;
        out[at + 3] = ~part.length & 255;
        out[at + 4] = (~part.length >> 8) & 255;
        out.set(part, at + 5);
        at += 5 + part.length;
    }
    new DataView(out.buffer).setUint32(at, adler32(data));
    return out.subarray(0, at + 4);
}

function adler32(data) {
    let a = 1;
    let b = 0;
    for (const byte of data) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

export function encodePng(rgba, width, height) {
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const parts = [new Uint8Array(PNG_SIG), chunk('IHDR', ihdr),
        chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

// --------------------------------------------------------------------- resize

// Box filter over the exact source rectangle each target pixel covers. Integer
// ratios or not, it is plain double arithmetic and therefore reproducible.
export function boxResize(rgba, width, height, toWidth, toHeight) {
    const out = new Uint8Array(toWidth * toHeight * 4);
    const sx = width / toWidth;
    const sy = height / toHeight;
    for (let y = 0; y < toHeight; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * sy)));
        for (let x = 0; x < toWidth; x++) {
            const x0 = Math.floor(x * sx);
            const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * sx)));
            const acc = [0, 0, 0, 0];
            for (let j = y0; j < y1; j++) {
                for (let i = x0; i < x1; i++) {
                    for (let c = 0; c < 4; c++) acc[c] += rgba[(j * width + i) * 4 + c];
                }
            }
            const n = (y1 - y0) * (x1 - x0);
            for (let c = 0; c < 4; c++) out[(y * toWidth + x) * 4 + c] = Math.round(acc[c] / n);
        }
    }
    return out;
}
