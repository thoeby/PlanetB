"""Runs a splatworld on one machine.

The same code serves a laptop and a real server: `splatworld run` starts the
file store and the static client, applies the schema, and supervises PostgREST.
It computes nothing about the world — every atom still runs in a browser tab
(Invariant 9).
"""
# Kept equal to client/version.txt, which the setup page reads straight from
# the checkout. The page compares the two: a static file is whatever was last
# pulled, so a server answering with an older version is proof that what is
# running is not what is on disk — the one thing that cannot be detected by
# the running code itself, because the running code is the thing at fault.
__version__ = "0.4.2"
