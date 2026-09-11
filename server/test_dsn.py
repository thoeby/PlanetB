"""The DSN handed to PostgREST, and what counts as a live API.

Both were found by running `splatworld run` on a machine whose PGHOST is the
Unix socket directory Debian and Ubuntu install by default. The API answered
503 "Could not query the database for the schema cache" for ever, `doctor`
reported the database healthy, and every restart said "API already running"
and left the broken one in place.
"""

import urllib.error

from splatworld.config import load
from splatworld import services


def cfg(**over):
    return load(over)


def test_socket_host_is_not_a_url():
    """A URL has nowhere to put /var/run/postgresql; the keyword form does."""
    dsn = cfg(pg_host="/var/run/postgresql", pg_database="splatworld").authenticator_dsn()
    assert dsn.startswith("host='/var/run/postgresql'")
    assert "://" not in dsn
    assert "dbname='splatworld'" in dsn


def test_tcp_host_still_works():
    dsn = cfg(pg_host="127.0.0.1", pg_port=5433).authenticator_dsn()
    assert "host='127.0.0.1'" in dsn
    assert "port='5433'" in dsn


def test_password_with_specials_is_quoted():
    dsn = cfg(authenticator_password="a b'c\\d").authenticator_dsn()
    assert "password='a b\\'c\\\\d'" in dsn


class _Res:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_a_503_is_not_alive(monkeypatch):
    """PostgREST that cannot reach the database answers 503 to everything.
    Counting that as alive meant run() adopted it and started nothing."""
    def raise_503(*a, **k):
        raise urllib.error.HTTPError("u", 503, "Service Unavailable", {}, None)

    monkeypatch.setattr(services.urllib.request, "urlopen", raise_503)
    assert services.alive(cfg()) is False


def test_a_404_is_alive(monkeypatch):
    """404 on / is normal for PostgREST and means it is up."""
    def raise_404(*a, **k):
        raise urllib.error.HTTPError("u", 404, "Not Found", {}, None)

    monkeypatch.setattr(services.urllib.request, "urlopen", raise_404)
    assert services.alive(cfg()) is True


def test_nothing_listening_is_not_alive(monkeypatch):
    def refuse(*a, **k):
        raise OSError(111, "Connection refused")

    monkeypatch.setattr(services.urllib.request, "urlopen", refuse)
    assert services.alive(cfg()) is False


def test_200_is_alive(monkeypatch):
    monkeypatch.setattr(services.urllib.request, "urlopen", lambda *a, **k: _Res(200))
    assert services.alive(cfg()) is True
