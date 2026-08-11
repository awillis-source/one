"""Price book includes, and the casket catalog import."""

import importlib.util
from pathlib import Path

import pytest

from tmg_quotes import PriceBook, PriceBookError

REPO = Path(__file__).resolve().parent.parent


def _load_importer():
    spec = importlib.util.spec_from_file_location(
        "import_casket_catalog", REPO / "scripts/import_casket_catalog.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


importer = _load_importer()


@pytest.mark.parametrize(
    "material,blurb,fits",
    [
        # A collection blurb compresses its materials; these are matches.
        ("18 Gauge", "18 & 20 Gauge Steel", True),
        ("48 oz Bronze", "48 & 32 oz Bronze, Copper", True),
        ("Poplar", "Poplar, Cedar & Pine", True),
        # These genuinely do not belong to the collection.
        ("Stainless Steel", "48 & 32 oz Bronze, Copper", False),
        ("Maple", "Mahogany, Walnut & Cherry", False),
        ("20 Gauge Non-Gasketed", "20 Gauge Steel", False),
    ],
)
def test_material_fits_its_collection(material, blurb, fits):
    assert importer.material_fits(material, blurb) is fits


def test_material_fits_when_the_collection_says_nothing():
    assert importer.material_fits("Oak", "") is True


def test_sku_is_derived_from_the_catalog_id():
    assert importer.sku_for({"id": "1058-antique-white"}) == "CKT-1058-ANTIQUE-WHITE"


def test_price_book_merges_included_files():
    book = PriceBook.load(REPO / "data/price_book.yaml")
    # Cemetery merchandise from the main file...
    assert book.get("VAULT-AEGEAN").category == "vault"
    # ...and caskets from the included one.
    caskets = book.in_category("casket")
    assert len(caskets) == 254
    assert all(c.price.low == c.price.high for c in caskets), "caskets are single-priced"
    assert all(c.taxable for c in caskets)


def test_included_file_cannot_redefine_a_sku(tmp_path):
    (tmp_path / "child.yaml").write_text(
        "items:\n  - sku: DUP\n    name: Child\n    price: 5\n"
    )
    parent = tmp_path / "parent.yaml"
    parent.write_text(
        "include:\n  - child.yaml\nitems:\n  - sku: DUP\n    name: Parent\n    price: 10\n"
    )
    with pytest.raises(PriceBookError, match="already defined"):
        PriceBook.load(parent)


def test_circular_includes_are_rejected(tmp_path):
    a = tmp_path / "a.yaml"
    b = tmp_path / "b.yaml"
    a.write_text("include:\n  - b.yaml\nitems:\n  - sku: A\n    name: A\n    price: 1\n")
    b.write_text("include:\n  - a.yaml\nitems:\n  - sku: B\n    name: B\n    price: 1\n")
    with pytest.raises(PriceBookError, match="circular"):
        PriceBook.load(a)


def test_items_needing_review_are_flagged_not_silently_imported():
    book = PriceBook.load(REPO / "data/caskets.yaml")
    truncated = [i for i in book if i.name.endswith("…")]
    flagged = [i for i in truncated if "confirm full finish name" in (i.notes or "")]
    assert truncated, "the source catalog has truncated names"
    assert len(flagged) == len(truncated), "every truncated name carries a note"


def test_casket_photos_referenced_by_the_price_book_exist():
    book = PriceBook.load(REPO / "data/caskets.yaml")
    missing = [i.sku for i in book if i.image and not (REPO / i.image).exists()]
    assert not missing
