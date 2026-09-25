#!/usr/bin/env python3
"""elx-probe.py — which write shapes a real elx server accepts.

Run beside the server author, against a live server:

    python tools/elx-probe.py http://127.0.0.1:8080 [flow.elx]

Without a file it downloads the first process on the server and re-uploads it
under a probe name. Every process it creates is deleted again. Prints, per
attempt, the HTTP status and the envelope's <error> message; the answers go
into docs/flow.md's "Record the first real run" table.
"""
import sys
import time
import urllib.error
import urllib.request
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

PREFIX = "/api/v1"


def call(base, method, path, body=None, ctype=None, headers=None):
    req = urllib.request.Request(base + PREFIX + path, method=method,
                                 data=body.encode() if isinstance(body, str) else body)
    req.add_header("Accept", "application/xml")
    if ctype:
        req.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, dict(res.headers), res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")
    except OSError as e:
        return 0, {}, str(e)


def said(text):
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return text.strip()[:200]
    code = root.findtext("error/code") or "0"
    msg = (root.findtext("error/message") or "").strip()
    return f"code={code} {msg}"


def show(label, r):
    status, headers, text = r
    print(f"  {label:<44} HTTP {status}  {said(text)}")
    return r


def wrap(data):
    return f'<elx_api_msg type="request" version="1"><data>{data}</data></elx_api_msg>'


def doc(elx):
    return ('<document content-type="0" encoding-type="1"><content>'
            f"{escape(elx)}</content></document>")


def processes(base):
    _, _, text = call(base, "GET", "/process?limit=200&offset=0")
    root = ET.fromstring(text)
    return [(p.findtext("id") or p.get("id"), p.findtext("name"))
            for p in root.iter("process")]


def cleanup(base, name):
    for pid, pname in processes(base):
        if pname and pname.startswith(name):
            show(f"DELETE /process/{pid} ({pname})", call(base, "DELETE", f"/process/{pid}"))


def main():
    base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8080"
    print("status:", said(call(base, "GET", "/system/status")[2]))
    rows = processes(base)
    print(f"{len(rows)} processes")
    if len(sys.argv) > 2:
        elx = open(sys.argv[2], encoding="utf-8").read()
    else:
        _, _, text = call(base, "GET", f"/process/{rows[0][0]}/download?type=elx")
        elx = ET.fromstring(text).findtext(".//document/content")
    name = f"probe-{int(time.time())}"

    print("\nCORS preflight (what the browser sends before PUT/PATCH/DELETE):")
    status, headers, _ = show("OPTIONS /process", call(base, "OPTIONS", "/process", headers={
        "Origin": "http://localhost:8000", "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type"}))
    for k in ("Access-Control-Allow-Origin", "Access-Control-Allow-Methods",
              "Access-Control-Allow-Headers"):
        print(f"    {k}: {headers.get(k, '(none)')}")

    print("\nCreate a process:")
    n = iter(range(1, 99))
    attempts = [
        ("PUT  raw ELX ?name=", "PUT", f"/process?name={name}-{next(n)}", elx, "application/xml"),
        ("POST raw ELX ?name=", "POST", f"/process?name={name}-{next(n)}", elx, "application/xml"),
    ]
    for method in ("PUT", "POST"):
        k = next(n)
        attempts.append((f"{method} envelope name+document", method, "/process",
                         wrap(f"<name>{name}-{k}</name>{doc(elx)}"), "application/xml"))
        k = next(n)
        attempts.append((f"{method} envelope process/name+document", method, "/process",
                         wrap(f"<process><name>{name}-{k}</name>{doc(elx)}</process>"),
                         "application/xml"))
        k = next(n)
        attempts.append((f"{method} envelope name+elx_document", method, "/process",
                         wrap(f"<name>{name}-{k}</name><elx_document>{escape(elx)}"
                              "</elx_document>"), "application/xml"))
    for label, method, path, body, ctype in attempts:
        show(label, call(base, method, path, body, ctype))

    made = [(pid, p) for pid, p in processes(base) if p and p.startswith(name)]
    print("\ncreated:", made or "nothing")
    if made:
        pid = made[0][0]
        print(f"\nUpdate process {pid}:")
        show("PATCH raw ELX", call(base, "PATCH", f"/process/{pid}", elx, "application/xml"))
        show("PATCH envelope document", call(base, "PATCH", f"/process/{pid}",
                                             wrap(doc(elx)), "application/xml"))
        show("POST  envelope document", call(base, "POST", f"/process/{pid}",
                                             wrap(doc(elx)), "application/xml"))
    print("\nValidate:")
    show("POST /process/validate raw ELX", call(base, "POST", "/process/validate",
                                                elx, "application/xml"))
    show("POST /process/validate envelope", call(base, "POST", "/process/validate",
                                                 wrap(doc(elx)), "application/xml"))
    print("\nCleanup:")
    cleanup(base, name)


if __name__ == "__main__":
    main()
