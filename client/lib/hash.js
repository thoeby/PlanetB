// hash.js — content addressing. Every artifact is named by the sha256 of its
// bytes (Invariant 1), and this is where the client computes it.
//
// WebCrypto only exists in a secure context: https, or localhost. A tab served
// over plain http from anywhere else cannot upload, which is the right failure
// — it could not have been trusted with a token either.

export function subtle() {
    const s = globalThis.crypto?.subtle;
    if (!s) {
        throw new Error('WebCrypto is unavailable: serve this page over https or localhost');
    }
    return s;
}

export const hex = (buf) => Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

// bytes: ArrayBuffer, TypedArray or DataView.
export async function sha256(bytes) {
    const view = ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    return hex(await subtle().digest('SHA-256', view));
}
