// tar.js — `assemble` produces four files and submit_atom takes one artifact
// hash, so the four travel as one. ustar, uncompressed, no timestamps and no
// ownership: two runs of the same atom must produce the same bytes.

const BLOCK = 512;
const enc = new TextEncoder();

function field(header, offset, length, value) {
    const bytes = enc.encode(value);
    if (bytes.length > length) throw new Error(`tar field overflows: ${value}`);
    header.set(bytes, offset);
}

const octal = (n, width) => n.toString(8).padStart(width - 1, '0');

function head(name, size) {
    const h = new Uint8Array(BLOCK);
    field(h, 0, 100, name);
    field(h, 100, 8, `${octal(0o644, 8)} `);
    field(h, 108, 8, `${octal(0, 8)} `);
    field(h, 116, 8, `${octal(0, 8)} `);
    field(h, 124, 12, `${octal(size, 12)} `);
    field(h, 136, 12, `${octal(0, 12)} `);   // mtime 0: bytes must not vary with time
    h.fill(32, 148, 156);                    // checksum computed over spaces
    field(h, 156, 1, '0');
    field(h, 257, 8, 'ustar\x0000');
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${octal(sum, 7)}\0`);
    return h;
}

// entries: [{ name, bytes }], written in the order given.
export function writeTar(entries) {
    const parts = [];
    let total = 0;
    for (const { name, bytes } of entries) {
        const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
        parts.push(head(name, body.length), body, new Uint8Array(pad));
        total += BLOCK + body.length + pad;
    }
    parts.push(new Uint8Array(BLOCK * 2));   // two empty blocks end the archive
    total += BLOCK * 2;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

const str = (b, o, n) => new TextDecoder('ascii').decode(b.subarray(o, o + n))
    .replace(/\0.*$/, '').trim();

export function readTar(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const files = new Map();
    for (let at = 0; at + BLOCK <= buf.length;) {
        const name = str(buf, at, 100);
        if (!name) break;
        const size = parseInt(str(buf, at + 124, 12), 8);
        files.set(name, buf.subarray(at + BLOCK, at + BLOCK + size));
        at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
    return files;
}
