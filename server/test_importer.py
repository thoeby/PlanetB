"""What an import makes of your columns (docs/import.md)."""
from __future__ import annotations

from splatworld.importer import props_of


def test_a_column_of_words_is_kept_as_words():
    spec = {"props": {"landuse": "nutzung", "leaf_type": "laub"}}
    got = props_of(spec, {"nutzung": "forest", "laub": "broadleaved"})
    assert got == {"landuse": "forest", "leaf_type": "broadleaved"}


def test_a_column_of_numbers_is_a_number_units_and_all():
    spec = {"props": {"height": "hoehe", "density": "dichte"}}
    assert props_of(spec, {"hoehe": "12 m", "dichte": "3,5"}) == {"height": 12.0, "density": 3.5}


def test_an_osm_key_stays_words_even_when_it_looks_like_a_number():
    spec = {"props": {"highway": "strasse", "name": "n"}}
    assert props_of(spec, {"strasse": "1", "n": "B12"}) == {"highway": "1", "name": "B12"}


def test_blank_and_missing_columns_say_nothing():
    spec = {"props": {"height": "hoehe", "landuse": "nutzung"}, "keep": ["id"]}
    assert props_of(spec, {"hoehe": " ", "id": 7}) == {"id": 7}
