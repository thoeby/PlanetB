#!/usr/bin/env python3
"""register.py — a maker's folder, into the world (TASKS-live.md LV.8).

No git, no Forgejo: a product is a folder,

    model.glb      the thing (a model), or plugin.xml + assets/ (a plugin)
    product.json   name, markings, triggers, needs, price, editions, licence,
                   how it is sold (policy, term) and which channel this is
    flow.elx       what it does, on a process server (optional; a `flow`
                   product is this file alone)

and this puts it in the world from any machine with a login:

    SPLATWORLD_EMAIL=… SPLATWORLD_PASSWORD=… python3 tools/register.py <folder>

It canonicalises model.glb with the page's own canoniser (tools/canon.mjs),
checks product.json, hashes flow.elx, uploads what the store has not got,
registers the product the first time (and writes its number to <folder>/.san)
and points the named channel at this version. Registering the same folder
twice changes nothing; a changed GLB moves the channel, and rights that pin a
hash keep theirs (db/0207). Stdlib only: it is a player's tool, not the
server's (Invariant 10), and every write it makes is the maker's, under RLS.
"""

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
LICENCES = ('cc0', 'free', 'paid', 'limited')
POLICIES = ('once', 'subscription', 'pinned')
TYPES = ('model', 'plugin', 'flow')
CHANNELS = ('current', 'legacy')
# What a flow may ask for (LV.9): ports on its own thing or the whole land, up
# to so much money a day, moving its own thing, emitting events, holding.
NEEDS = {'ports': ('own', 'area'), 'move': ('own',)}


class Refused(Exception):
    """A sentence for the maker: what is wrong, in words."""


# ------------------------------------------------------------------ checking

def check_needs(needs):
    for key, value in needs.items():
        if key in NEEDS:
            if value not in NEEDS[key]:
                raise Refused('needs.%s is one of %s, not %r' % (key, ', '.join(NEEDS[key]), value))
        elif key == 'pay':
            if not isinstance(value, dict) or not isinstance(value.get('max_per_day'), (int, float)) \
                    or value['max_per_day'] < 0:
                raise Refused('needs.pay says how much a day at most: {"max_per_day": 5}')
        elif key in ('emit', 'hold'):
            if not isinstance(value, bool):
                raise Refused('needs.%s is true or false' % key)
        else:
            raise Refused('a flow cannot need "%s"' % key)


def check_product(p, folder):
    if not isinstance(p.get('name'), str) or not p['name'].strip():
        raise Refused('product.json has no name')
    kind = p.get('type', 'model')
    if kind not in TYPES:
        raise Refused('type is one of %s' % ', '.join(TYPES))
    if p.get('licence', 'cc0') not in LICENCES:
        raise Refused('licence is one of %s' % ', '.join(LICENCES))
    if not isinstance(p.get('price', 0), (int, float)) or p.get('price', 0) < 0:
        raise Refused('price is a number, 0 or more')
    if p.get('licence') == 'limited' and not isinstance(p.get('editions'), int):
        raise Refused('a limited product says how many editions there are')
    if p.get('policy', 'once') not in POLICIES:
        raise Refused('policy is one of %s' % ', '.join(POLICIES))
    if p.get('channel', 'current') not in CHANNELS:
        raise Refused('channel is current or legacy')
    for key in ('marks', 'needs'):
        if not isinstance(p.get(key, {}), dict):
            raise Refused('%s is an object' % key)
    for t in p.get('marks', {}).get('triggers', []):
        if not isinstance(t, dict) or not isinstance(t.get('kind'), str):
            raise Refused('a trigger is {"kind": …, "params": {…}}')
    check_needs(p.get('needs', {}))
    wants = {'model': 'model.glb', 'plugin': 'plugin.xml', 'flow': 'flow.elx'}[kind]
    if not (folder / wants).is_file():
        raise Refused('a %s product needs %s in the folder' % (kind, wants))


# ------------------------------------------------------------------- the file

def canon_glb(folder, marks):
    """The page's own canonical GLB (client/lib/canon.js), via node."""
    with tempfile.TemporaryDirectory() as tmp:
        out, spec = pathlib.Path(tmp) / 'canon.glb', pathlib.Path(tmp) / 'marks.json'
        spec.write_text(json.dumps(marks))
        done = subprocess.run(['node', str(HERE / 'canon.mjs'), str(folder / 'model.glb'),
                               str(out), str(spec)], capture_output=True, text=True)
        if done.returncode != 0:
            raise Refused('model.glb could not be canonicalised: %s' % done.stderr.strip())
        said = json.loads(done.stdout)
        return out.read_bytes(), said


def _octal(n, width):
    return format(n, 'o').rjust(width - 1, '0')


def _head(name, size):
    """One ustar header, as client/lib/tar.js writes it."""
    h = bytearray(512)
    for off, value in ((0, name), (100, _octal(0o644, 8) + ' '), (108, _octal(0, 8) + ' '),
                       (116, _octal(0, 8) + ' '), (124, _octal(size, 12) + ' '),
                       (136, _octal(0, 12) + ' '), (156, '0'), (257, 'ustar\x0000')):
        raw = value.encode()
        h[off:off + len(raw)] = raw
    h[148:156] = b' ' * 8
    h[148:155] = (_octal(sum(h), 7) + '\x00').encode()
    return bytes(h)


def plugin_tar(folder):
    """The plugin folder as its canonical tar (client/lib/plugintar.js)."""
    files = sorted(p for p in folder.rglob('*') if p.is_file()
                   and p.name not in ('product.json', '.san') and not p.name.startswith('.'))
    out = bytearray()
    for p in sorted(files, key=lambda f: f.relative_to(folder).as_posix().encode()):
        body = p.read_bytes()
        out += _head(p.relative_to(folder).as_posix(), len(body)) + body
        out += b'\0' * ((512 - len(body) % 512) % 512)
    return bytes(out + b'\0' * 1024)


# ------------------------------------------------------------------ the world

class World:
    """The world as a player sees it: PostgREST and the file store."""

    def __init__(self, api, files):
        self.api, self.files, self.token = api.rstrip('/'), files.rstrip('/'), None

    def call(self, url, data=None, method='POST', headers=None):
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        if self.token:
            req.add_header('Authorization', 'Bearer ' + self.token)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def rpc(self, fn, args):
        status, body = self.call('%s/rpc/%s' % (self.api, fn), json.dumps(args).encode(),
                                 headers={'Content-Type': 'application/json'})
        said = json.loads(body or b'null')
        if status >= 300:
            raise Refused('%s: %s' % (fn, said.get('message') if isinstance(said, dict) else said))
        return said

    def login(self, email, pw):
        self.token = self.rpc('login', {'email': email, 'pw': pw})
        if isinstance(self.token, dict):
            self.token = self.token.get('token')

    def upload(self, data, ext, kind, algo):
        """Into the store if it is not there, and registered as an artifact."""
        sha = hashlib.sha256(data).hexdigest()
        status, body = self.call('%s/assets/%s.%s' % (self.files, sha, ext), data, 'PUT',
                                 {'X-Sha256': sha, 'Content-Type': 'application/octet-stream'})
        if status not in (200, 201, 204, 409):
            raise Refused('the store refused %s.%s (%s): %s' % (sha[:12], ext, status,
                                                              body.decode(errors='replace')[:200]))
        self.rpc('register_artifact', {'sha256': sha, 'kind': kind, 'bytes': len(data),
                                       'algo_version': algo})
        return sha


# ----------------------------------------------------------------- registering

def the_file(world, folder, p):
    """(sha, canon_version, meta) of the product's own file, uploaded."""
    kind = p.get('type', 'model')
    if kind == 'model':
        glb, said = canon_glb(folder, p.get('marks', {}))
        sha = world.upload(glb, 'glb', 'glb', 'canon-v%d' % said['canon_version'])
        return sha, said['canon_version'], said['meta']
    if kind == 'plugin':
        xml = (folder / 'plugin.xml').read_text()
        pid = xml.split('id="', 1)[1].split('"', 1)[0] if '<plugin' in xml else ''
        sha = world.upload(plugin_tar(folder), 'tar', 'plugin', 'plugin-tar-v1')
        return sha, 0, {'parts': {'plugin': pid, 'blocks': xml.count('<node id="')}}
    return world.upload((folder / 'flow.elx').read_bytes(), 'elx', 'flow', 'elx'), 0, {}


def meta_of(p, canon_meta):
    meta = {'name': p['name'], 'type': p.get('type', 'model'),
            'category': p.get('category', 'prop'), 'license': p.get('licence', 'cc0'),
            'price': p.get('price', 0), 'policy': p.get('policy', 'once')}
    if p.get('licence') == 'limited':
        meta['editions'] = p['editions']
    if p.get('policy') == 'subscription':
        meta['term'] = p.get('term', '30 days')
    meta.update(canon_meta)
    if p.get('type', 'model') == 'model' and p.get('marks'):
        meta['parts'] = p['marks']
    return meta


def register(world, folder):
    p = json.loads((folder / 'product.json').read_text())
    check_product(p, folder)
    sha, canon_version, canon_meta = the_file(world, folder, p)
    flow = None
    if p.get('type', 'model') != 'flow' and (folder / 'flow.elx').is_file():
        flow = world.upload((folder / 'flow.elx').read_bytes(), 'elx', 'flow', 'elx')
    state = folder / '.san'
    san = p.get('san') or (state.read_text().strip() if state.is_file() else None) \
        or world.rpc('my_product', {'name': p['name']})
    if not san:
        san = world.rpc('register_asset', {'sha256': sha, 'canon_version': canon_version,
                                           'meta': meta_of(p, canon_meta)})
    state.write_text(san + '\n')
    pointer = world.rpc('set_pointer', {'san': san, 'channel': p.get('channel', 'current'),
                                        'sha256': sha, 'fix': bool(p.get('fix', False)),
                                        'needs': p.get('needs', {}), 'flow_sha256': flow})
    return san, sha, flow, pointer


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder')
    ap.add_argument('--api', default=os.environ.get('API_URL', 'http://localhost:3000'))
    ap.add_argument('--files', default=os.environ.get('FILES_URL', 'http://localhost:8081'))
    ap.add_argument('--email', default=os.environ.get('SPLATWORLD_EMAIL'))
    ap.add_argument('--password', default=os.environ.get('SPLATWORLD_PASSWORD'))
    a = ap.parse_args()
    folder = pathlib.Path(a.folder).resolve()
    world = World(a.api, a.files)
    try:
        if not (a.email and a.password):
            raise Refused('sign in: SPLATWORLD_EMAIL and SPLATWORLD_PASSWORD, or --email/--password')
        world.login(a.email, a.password)
        san, sha, flow, pointer = register(world, folder)
    except Refused as err:
        print('register: %s' % err, file=sys.stderr)
        return 1
    print('%s  %s -> %s%s' % (san, 'current' if pointer.get('current') == sha else 'legacy',
                              sha[:12], ' + flow ' + flow[:12] if flow else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
