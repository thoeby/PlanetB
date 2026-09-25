"""The IPFS CID of a file, with the world's fixed settings (TASKS-live.md LV.11).

sha256 is a file's identity; the CID is how peers that are not this server
find it. It is only worth recording if anybody can recompute it from the
bytes, so the settings are fixed and written here a second time, without the
node (tools/node.mjs) or any IPFS library:

    UnixFS file, CIDv1, raw leaves, 256 KiB chunks,
    balanced DAG of at most 174 links a node, a single leaf is its own CID

which is `ipfs add --cid-version=1 --raw-leaves --chunker=size-262144` and
ipfs-unixfs-importer with the same options. tools/files-test.sh holds this
and the node to the same answer for every file it stores.
"""

import base64
import hashlib

CHUNK = 262144
LINKS = 174
RAW, DAG_PB, SHA2_256 = 0x55, 0x70, 0x12


def _varint(n):
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _field(number, wire, payload):
    """One protobuf field: bytes for wire type 2, an int for wire type 0."""
    key = _varint((number << 3) | wire)
    if wire == 0:
        return key + _varint(payload)
    return key + _varint(len(payload)) + payload


def _cid(codec, block):
    """CIDv1 bytes of a block: version, codec, sha2-256 multihash."""
    digest = hashlib.sha256(block).digest()
    return _varint(1) + _varint(codec) + _varint(SHA2_256) + _varint(len(digest)) + digest


def _unixfs_file(sizes):
    """UnixFS Data for a file node: Type=File, filesize, a blocksize per child."""
    out = _field(1, 0, 2) + _field(3, 0, sum(sizes))
    for s in sizes:
        out += _field(4, 0, s)
    return out


def _dag_pb(children):
    """A dag-pb node over (cid, tsize, filesize) children: links, then data."""
    links = b''.join(_field(2, 2, _field(1, 2, cid) + _field(2, 2, b'') + _field(3, 0, tsize))
                     for cid, tsize, _ in children)
    return links + _field(1, 2, _unixfs_file([size for _, _, size in children]))


def cid_bytes(data):
    """The CID of a whole file, as bytes."""
    leaves = []
    for at in range(0, max(len(data), 1), CHUNK):
        chunk = data[at:at + CHUNK]
        leaves.append((_cid(RAW, chunk), len(chunk), len(chunk)))
    level = leaves
    while len(level) > 1:
        up = []
        for at in range(0, len(level), LINKS):
            group = level[at:at + LINKS]
            node = _dag_pb(group)
            up.append((_cid(DAG_PB, node), len(node) + sum(t for _, t, _ in group),
                       sum(s for _, _, s in group)))
        level = up
    return level[0][0]


def cid_of(data):
    """The CID as text: multibase base32, lower case, the `b…` form."""
    return 'b' + base64.b32encode(cid_bytes(data)).decode().lower().rstrip('=')
