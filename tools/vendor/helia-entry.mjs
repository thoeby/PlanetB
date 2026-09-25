// What the tab takes from Helia's world (LV.12), bundled once into
// client/vendor/helia/helia.js by tools/vendor.sh (esbuild, one ES module).
// The client has no bundler (CLAUDE.md); this is the one vendored file it
// imports for peers, as Splat.js and PlayCanvas are vendored for drawing.
export { createLibp2p } from 'libp2p';
export { webSockets } from '@libp2p/websockets';
export { webRTC } from '@libp2p/webrtc';
export { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
export { noise } from '@chainsafe/libp2p-noise';
export { yamux } from '@chainsafe/libp2p-yamux';
export { identify } from '@libp2p/identify';
export { multiaddr } from '@multiformats/multiaddr';
export { IDBBlockstore } from 'blockstore-idb';
export { MemoryBlockstore } from 'blockstore-core/memory';
export { importer } from 'ipfs-unixfs-importer';
export { fixedSize } from 'ipfs-unixfs-importer/chunker';
export { balanced } from 'ipfs-unixfs-importer/layout';
export { CID } from 'multiformats/cid';
export { exporter } from 'ipfs-unixfs-exporter';
export { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
