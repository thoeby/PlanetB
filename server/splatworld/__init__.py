"""Runs a splatworld on one machine.

The same code serves a laptop and a real server: `splatworld run` starts the
file store and the static client, applies the schema, and supervises PostgREST.
It computes nothing about the world — every atom still runs in a browser tab
(Invariant 9).
"""
__version__ = "0.1.0"
