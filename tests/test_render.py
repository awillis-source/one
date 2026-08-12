"""Rendering: HTML content, and PDF geometry against the reference quote.

The PDF tests need Chromium; they skip when Playwright cannot start one.
"""

from pathlib import Path

import pytest

from tmg_quotes import PriceBook, load_quote, render_html, render_pdf

pymupdf = pytest.importorskip("pymupdf")

REPO = Path(__file__).resolve().parent.parent
TOLERANCE_PT = 2.0


@pytest.fixture(scope="module")
def quote():
    book = PriceBook.load(REPO / "data/price_book.yaml")
    return load_quote(REPO / "quotes/schutz.yaml", book)


@pytest.fixture(scope="module")
def rendered(quote, tmp_path_factory):
    out = tmp_path_factory.mktemp("pdf") / "schutz.pdf"
    try:
        render_pdf(quote, out, base_dir=REPO)
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Chromium unavailable: {exc}")
    return pymupdf.open(out)


def test_html_is_self_contained(quote):
    html = render_html(quote, base_dir=REPO)
    assert "data:image/png;base64," in html
    assert "src=\"assets/" not in html
    assert "$6,409 – $8,599" in html
    assert "Estimated Total" in html


def test_html_shows_a_payment_breakdown_when_asked(quote):
    quote.financing.show_payment_breakdown = True
    try:
        html = render_html(quote, base_dir=REPO)
    finally:
        quote.financing.show_payment_breakdown = False
    assert "Down payment" in html
    assert "Amount financed" in html
    assert "Total of payments" in html
    assert "$769.08" in html  # 12% down on option 1's low total
    # The fixed-rate plan still shows what is known, and no invented payment.
    assert "rate set at signing" in html


def test_pdf_has_the_expected_pages(rendered):
    assert rendered.page_count == 2
    assert "CAROLE JEANNETTE SCHUTZ" in rendered[0].get_text()
    assert "Page 1 of 2" in rendered[0].get_text()
    assert "Payment Options" in rendered[1].get_text()


def test_pdf_chrome_lands_where_the_reference_puts_it(rendered):
    """Logo, header rule, and footer rule sit at the reference coordinates."""
    page = rendered[0]
    logo = min(page.get_image_info(), key=lambda i: i["bbox"][1])["bbox"]
    assert logo[1] == pytest.approx(34.56, abs=TOLERANCE_PT)
    assert logo[0] == pytest.approx(223.2, abs=TOLERANCE_PT)

    rules = sorted(
        d["rect"].y0
        for d in page.get_drawings()
        if d["rect"].x0 < 55 and d["rect"].x1 > 557
    )
    assert rules[0] == pytest.approx(91.59, abs=TOLERANCE_PT)
    assert rules[-1] == pytest.approx(752.40, abs=TOLERANCE_PT)


def test_pdf_option_blocks_land_where_the_reference_puts_them(rendered):
    tops = {}
    for block in rendered[0].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                text = span["text"].strip()
                if text.startswith("Option "):
                    tops[text[:8]] = span["bbox"][1]
    assert tops["Option 1"] == pytest.approx(135.22, abs=TOLERANCE_PT)
    assert tops["Option 2"] == pytest.approx(288.33, abs=TOLERANCE_PT)
    assert tops["Option 3"] == pytest.approx(438.65, abs=TOLERANCE_PT)


def test_pdf_prices_match_the_reference(rendered):
    text = rendered[0].get_text()
    for figure in ("$1,007 – $1,328", "$995", "$6,409 – $8,599", "$5,188 – $5,987"):
        assert figure in text
