"""Price book loading, quote assembly, and totals."""

from decimal import Decimal

import pytest

from tmg_quotes import PriceBook, PriceBookError, QuoteSpecError, build_quote, load_quote
from tmg_quotes.models import Money
from tmg_quotes.render import money

PRICE_BOOK = "data/price_book.yaml"


@pytest.fixture(scope="module")
def book():
    return PriceBook.load(PRICE_BOOK)


def test_money_parses_scalars_ranges_and_strings():
    assert Money.parse(995) == Money(Decimal(995), Decimal(995))
    assert Money.parse("$1,007 - $1,328") == Money(Decimal(1007), Decimal(1328))
    assert Money.parse({"low": 10, "high": 20}).high == Decimal(20)
    assert not Money.parse(995).is_range


def test_money_rejects_inverted_range():
    with pytest.raises(ValueError):
        Money(Decimal(200), Decimal(100))


def test_money_formats_the_way_the_quote_shows_it():
    assert money(Money.parse(995)) == "$995"
    assert money(Money.parse("1007-1328")) == "$1,007 – $1,328"


def test_price_book_lookup_and_categories(book):
    vault = book.get("VAULT-AEGEAN")
    assert vault.display_name == "Cremation Vault (Aegean)"
    assert vault.price.low == Decimal(1007)
    assert "marker" in book.categories()


def test_unknown_sku_suggests_a_near_match(book):
    with pytest.raises(PriceBookError) as excinfo:
        book.get("VAULT-AEGEN")
    assert "VAULT-AEGEAN" in str(excinfo.value)


def test_services_are_not_taxable(book):
    assert book.get("SVC-OC-CREMATION").taxable is False


def test_reference_quote_totals_match_the_original(book):
    """The three option totals from the Schutz quote, to the dollar."""
    quote = load_quote("quotes/schutz.yaml", book)
    totals = [(o.total.low, o.total.high) for o in quote.options]
    assert totals == [
        (Decimal(6409), Decimal(8599)),
        (Decimal(6638), Decimal(8136)),
        (Decimal(5188), Decimal(5987)),
    ]


def test_reference_quote_header_and_photos(book):
    quote = load_quote("quotes/schutz.yaml", book)
    assert quote.decedent == "Carole Jeannette Schutz"
    assert "Prepared for Jill Lang & Jan Richardson" in quote.header_line
    # Option 2 features the granite marker rather than its first pictured item.
    assert "granite-honor" in quote.options[1].image
    assert quote.options[1].caption.startswith("“Honor”")


def test_tax_applies_to_merchandise_only(book):
    quote = load_quote("quotes/schutz.yaml", book)
    option = quote.options[0]
    # 6409 total less the 995 non-taxable open & close.
    assert option.taxable_total.low == Decimal(5414)
    assert option.tax(Decimal("0.07")).low == Decimal("378.98")
    assert option.total_with_tax(Decimal("0.07")).low == Decimal("6787.98")


def test_quantity_multiplies_a_line(book):
    quote = build_quote(
        {
            "decedent": "Test Family",
            "options": [
                {
                    "title": "Two vaults",
                    "items": [{"sku": "VAULT-AEGEAN", "quantity": 2}],
                }
            ],
        },
        book,
    )
    line = quote.options[0].lines[0]
    assert line.label == "Cremation Vault (Aegean) x2"
    assert line.extended.low == Decimal(2014)


def test_adhoc_line_prices_in_the_spec(book):
    quote = build_quote(
        {
            "decedent": "Test Family",
            "options": [
                {
                    "title": "With a credit",
                    "items": [
                        "SVC-OC-CREMATION",
                        {"name": "Pre-need credit", "price": -0, "taxable": False},
                    ],
                }
            ],
        },
        book,
    )
    assert quote.options[0].lines[1].item.name == "Pre-need credit"


def test_spec_errors_are_reported_clearly(book):
    with pytest.raises(QuoteSpecError, match="decedent"):
        build_quote({"options": []}, book)
    with pytest.raises(QuoteSpecError, match="options"):
        build_quote({"decedent": "X"}, book)
    with pytest.raises(QuoteSpecError, match="no price book item"):
        build_quote(
            {"decedent": "X", "options": [{"title": "T", "items": ["NOPE"]}]}, book
        )


def test_rates_accept_percent_or_fraction(book):
    quote = build_quote(
        {
            "decedent": "X",
            "tax_rate": "7%",
            "options": [{"title": "T", "items": ["SVC-OC-CREMATION"]}],
            "financing": {
                "down_payment_percent": "12%",
                "plans": [{"months": 12, "apr": 0}, {"months": 60, "apr": "8.90%"}],
            },
        },
        book,
    )
    assert quote.tax_rate == Decimal("0.07")
    assert quote.financing.down_payment_percent == Decimal("0.12")
    assert quote.financing.plans[1].apr == Decimal("0.089")
    assert quote.financing.plans[1].display_rate == "8.90% APR"
    assert quote.financing.plans[0].display_rate == "0% APR"


def test_csv_price_book_loads(tmp_path):
    csv_path = tmp_path / "book.csv"
    csv_path.write_text(
        "Item Code,Description,Low,High,Category\n"
        "MRK-X,Granite Marker,1000,1500,marker\n"
        "SVC-Y,Open & Close,995,,service\n"
    )
    csv_book = PriceBook.load(csv_path)
    assert len(csv_book) == 2
    assert csv_book.get("MRK-X").price.high == Decimal(1500)
    assert not csv_book.get("SVC-Y").price.is_range
