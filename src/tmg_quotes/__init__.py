"""Quote generation for Tippecanoe Memory Gardens.

Typical use::

    from tmg_quotes import PriceBook, load_quote, render_pdf

    book = PriceBook.load("data/price_book.yaml")
    quote = load_quote("quotes/schutz.yaml", book)
    render_pdf(quote, "out/schutz.pdf")
"""

from .builder import QuoteSpecError, build_quote, load_quote
from .models import (
    Financing,
    FinancingPlan,
    Item,
    LineItem,
    Money,
    Option,
    PriceBookError,
    Quote,
)
from .pricebook import PriceBook
from .render import RenderError, render_html, render_pdf

__all__ = [
    "Financing",
    "FinancingPlan",
    "Item",
    "LineItem",
    "Money",
    "Option",
    "PriceBook",
    "PriceBookError",
    "Quote",
    "QuoteSpecError",
    "RenderError",
    "build_quote",
    "load_quote",
    "render_html",
    "render_pdf",
]

__version__ = "0.1.0"
