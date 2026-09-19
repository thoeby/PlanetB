"""A refused PUT must arrive as a status, not as a dropped connection.

The store answers some PUTs without reading their body — "already written" is
the common one, and the worker reads it as "these bytes are already here", not
as a failure. A body that is still being sent when the answer arrives lands on
a socket nobody is reading: the connection resets, and the browser reports
"NetworkError when attempting to fetch resource" with no status in it at all.
A sog is megabytes, so this was every upload of one.
"""
from __future__ import annotations

import http.client
import threading
from pathlib import Path

import pytest

from splatworld.config import Config
from splatworld.serve import Handler, Server


@pytest.fixture()
def store(tmp_path: Path):
    cfg = Config(repo=tmp_path, host="127.0.0.1", port=0,
                 files_root=tmp_path / "files")
    cfg.files.mkdir(parents=True)
    cfg.client_dir.mkdir(parents=True)
    srv = Server(cfg)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield cfg, srv.server_address[1]
    srv.shutdown()


def put(port: int, path: str, body: bytes) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request("PUT", path, body=body,
                     headers={"Content-Length": str(len(body)),
                              "X-Sha256": "0" * 64})
        return conn.getresponse().status
    finally:
        conn.close()


def test_a_path_already_written_answers_409_with_the_body_still_coming(store):
    cfg, port = store
    target = cfg.files / "tiles" / "14" / "1" / "1" / f"{'a' * 64}.sog"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"already here")
    # Big enough that it cannot all sit in a socket buffer: this is what reset
    # the connection instead of answering.
    status = put(port, f"/tiles/14/1/1/{'a' * 64}.sog", b"x" * (4 << 20))
    assert status == 409
    assert target.read_bytes() == b"already here"


def test_a_path_that_is_not_writable_answers_405_not_a_reset(store):
    _, port = store
    assert put(port, "/nowhere/at/all.sog", b"x" * (4 << 20)) == 405


def test_a_refusal_from_the_database_answers_with_its_status(store):
    # No API is running here, so can_write cannot be asked and the store
    # refuses — which still has to arrive as a status.
    _, port = store
    assert put(port, f"/tiles/14/1/1/{'b' * 64}.sog", b"x" * (4 << 20)) == 403


def test_the_drain_stops_at_the_end_of_the_body():
    class Fake:
        def __init__(self): self.left = 10
        def read(self, n):
            take = min(n, self.left)
            self.left -= take
            return b"y" * take

    handler = Handler.__new__(Handler)
    handler.rfile = Fake()
    handler._drain(10)
    assert handler.rfile.left == 0


def get(port: int, path: str) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request("GET", path)
        res = conn.getresponse()
        return res.status, res.read()
    finally:
        conn.close()


def test_a_tile_of_ground_already_on_disk_is_still_the_cutter_s_to_answer(store,
                                                                         monkeypatch):
    """The survey can be replaced under the same coverage.

    A cut that is already a file was served straight off the disk, so the
    staleness check never ran and a world whose elevation was swapped went on
    drawing the hill before it. Every request for a tile of ground goes through
    cut() now, which answers with the file it has when nothing has changed.
    """
    from splatworld import ground

    cfg, port = store
    target = ground.tile_path(cfg, 14, 8557, 5736)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"old")
    asked = []

    def cut(cfg_, z, x, y, kind="dem"):
        asked.append((z, x, y, kind))
        target.write_bytes(b"new")
        return target

    monkeypatch.setattr(ground, "cut", cut)
    status, body = get(port, "/geo/dem/14/8557/5736.r16")
    assert status == 200
    assert body == b"new", "what the cutter answered, not what was lying there"
    assert asked == [(14, 8557, 5736, "dem")]


def test_a_file_that_is_not_ground_is_served_as_it_is(store):
    cfg, port = store
    path = cfg.files / "assets" / "a.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"hello")
    assert get(port, "/assets/a.txt") == (200, b"hello")
