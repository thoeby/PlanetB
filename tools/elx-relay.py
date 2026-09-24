#!/usr/bin/env python3
"""elx-relay.py — lets a splatworld page talk to a process server that sends no
CORS headers (TASKS-flows.md; docs/flow.md "Reaching a real process server").

The elx server answers every request, but it does not say which pages may read
its answers, so a browser shows the page nothing and Automate says the server
"did not answer" (the reference editor has the same gap: wireon-process-editor
TASKS-V1.md 14.3). This relay runs on the player's own machine, beside their
process server, forwards every request to it unchanged, and adds the headers
on the way back. The page is pointed at the relay instead of the server.

It is the player's, like their process server: the world runs none of it and
sends nothing out (Invariant 9).

  python3 tools/elx-relay.py --to http://127.0.0.1:8080 --port 8090
  # then, in Automate: Server → Add a server… → http://127.0.0.1:8090

Standard library only.
"""
import argparse
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TARGET = 'http://127.0.0.1:8080'
ORIGIN = '*'
HOP = {'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
       'proxy-authorization', 'proxy-authenticate', 'host', 'content-length',
       'server', 'date'}


class Relay(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('relay: %s %s\n' % (self.command, self.path))

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', ORIGIN)
        self.send_header('Access-Control-Allow-Methods',
                         'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization')
        self.send_header('Access-Control-Max-Age', '600')

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def forward(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(TARGET + self.path, data=body, headers=headers,
                                     method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                status, got, data = res.status, res.headers, res.read()
        except urllib.error.HTTPError as err:
            status, got, data = err.code, err.headers, err.read()
        except OSError as err:
            msg = ('<elx_api_msg type="response" version="1"><data/><error><code>1</code>'
                   '<message language="en">the relay could not reach %s: %s</message>'
                   '</error></elx_api_msg>' % (TARGET, err)).encode()
            status, got, data = 502, {'Content-Type': 'application/xml'}, msg
        self.send_response(status)
        for k, v in got.items():
            if k.lower() not in HOP and not k.lower().startswith('access-control-'):
                self.send_header(k, v)
        self.cors()
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = forward


def main():
    global TARGET, ORIGIN
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--to', default=TARGET, help='the process server (default %(default)s)')
    ap.add_argument('--port', type=int, default=8090)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--origin', default='*',
                    help='the page origin allowed to read answers (default: any)')
    a = ap.parse_args()
    TARGET, ORIGIN = a.to.rstrip('/'), a.origin
    srv = ThreadingHTTPServer((a.bind, a.port), Relay)
    print('elx-relay: http://%s:%d -> %s' % (a.bind, a.port, TARGET), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
