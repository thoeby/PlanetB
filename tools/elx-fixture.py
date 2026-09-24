#!/usr/bin/env python3
"""elx-fixture.py — a stand-in process server for the player-run (TASKS-flows.md).

There is no process server in this container and none is reachable, so the F10
stories are given this one, the way they are given tools/geoserver-fixture.py
for a GeoServer. It answers the routes the reference editor documents
(wireon-process-editor docs/API-ENDPOINTS.md) under /api/v1, in the
<elx_api_msg> envelope, from memory, with CORS headers for any origin.

What it deliberately does not do:
- settle any open wire question. Write bodies are accepted as JSON *or* XML,
  and a new process's name is read from `?name=` (client/flow/server/process.js).
- run blocks. A job's run does exactly one thing a real server would: for
  every World "Write Port" block (plugin="world", id="port.write") it calls
  <world>/rpc/port_write with the job's `world_key`, as the World block's own
  composite does (client/flow/world/assets/nodes/port__write.xml).

  python3 tools/elx-fixture.py --port 8091 --name alpha \
      --plugins client/flow/palette/plugins --extra client/test/run/fixtures/weather.xml

Developer tooling (CLAUDE.md, tools/). Never part of the server.
"""
import argparse
import json
import pathlib
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from elx_fixture_routes import (LOCK, STATE, body_fields, envelope,  # noqa: E402
                                new_id, routes, run_job)

# ------------------------------------------------------------------ http

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def send(self, status, text, ctype='application/xml'):
        body = text.encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def handle_any(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if url.path.startswith('/__fixture/'):
            return self.fixture(url.path.split('/')[2:], query)
        if not url.path.startswith('/api/v1/'):
            return self.send(400, envelope(code=1, message='unknown request'))
        parts = [urllib.parse.unquote(p) for p in url.path[len('/api/v1/'):].split('/') if p]
        try:
            fields = body_fields(raw, self.headers.get('Content-Type', ''))
        except (ValueError, ET.ParseError):
            fields = {}
        with LOCK:
            status, data = routes(self.command, parts, query, fields, raw)
        if data is None:
            words = {404: 'not found', 409: 'a process with that name exists'}
            return self.send(200 if status == 409 else status,
                             envelope(code=status, message=words.get(status, 'unknown request')))
        return self.send(status, envelope(data))

    def fixture(self, parts, query):
        """What the run itself may ask: what the world answered, and one more
        run of a job the page has since deleted."""
        with LOCK:
            if parts[:1] == ['calls']:
                return self.send(200, json.dumps(STATE['calls']), 'application/json')
            if parts[:1] == ['replay']:
                j = STATE.get('gone', {}).get(query.get('job', [''])[0])
                if not j:
                    return self.send(404, '{}', 'application/json')
                code, lines = run_job(j)
                return self.send(200, json.dumps({'code': code, 'lines': lines}),
                                 'application/json')
        return self.send(404, '{}', 'application/json')

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any


def load_plugins(dirs, extra, without):
    out = []
    for d in dirs:
        for f in sorted(pathlib.Path(d).glob('*/plugin.xml')):
            out.append(f.read_text())
    out += [pathlib.Path(f).read_text() for f in extra]
    keep = []
    for x in out:
        m = re.search(r'<plugin[^>]*\bid="([^"]+)"', x)
        if not (m and m.group(1) in without):
            keep.append(x)
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--name', default='fixture')
    ap.add_argument('--plugins', action='append', default=[])
    ap.add_argument('--extra', action='append', default=[])
    ap.add_argument('--without', action='append', default=[])
    ap.add_argument('--process', action='append', default=[],
                    help='name=path: a process the server already has')
    a = ap.parse_args()
    STATE['version'] = 'fixture-1 (%s)' % a.name
    STATE['plugins'] = load_plugins(a.plugins, a.extra, set(a.without))
    for spec in a.process:
        name, path = spec.split('=', 1)
        pid = new_id()
        STATE['process'][pid] = {'id': pid, 'name': name,
                                 'elx': pathlib.Path(path).read_text()}
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    print('elx-fixture %s on %d, %d plugins' % (a.name, a.port, len(STATE['plugins'])),
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == '__main__':
    main()
