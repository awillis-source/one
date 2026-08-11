"""Command line interface: build quotes, and inspect the price book."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .builder import QuoteSpecError, load_quote
from .models import PriceBookError
from .pricebook import PriceBook
from .render import RenderError, money, render_html, render_pdf

DEFAULT_PRICE_BOOK = Path("data/price_book.yaml")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tmg-quote", description="Build cemetery quotes from the price book."
    )
    parser.add_argument(
        "-p",
        "--price-book",
        type=Path,
        default=DEFAULT_PRICE_BOOK,
        help=f"price book (.yaml or .csv), default {DEFAULT_PRICE_BOOK}",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="render a quote spec to PDF or HTML")
    build.add_argument("spec", type=Path, help="quote spec YAML")
    build.add_argument(
        "-o", "--output", type=Path, help="output path (.pdf or .html); default out/<spec>.pdf"
    )
    build.add_argument(
        "--html", action="store_true", help="write HTML instead of PDF"
    )

    check = sub.add_parser("check", help="validate a quote spec and print its totals")
    check.add_argument("spec", type=Path, help="quote spec YAML")

    items = sub.add_parser("items", help="list price book items")
    items.add_argument("-c", "--category", help="only this category")

    args = parser.parse_args(argv)

    try:
        book = PriceBook.load(args.price_book)
        if args.command == "build":
            return _build(args, book)
        if args.command == "check":
            return _check(args, book)
        return _items(args, book)
    except (PriceBookError, QuoteSpecError, RenderError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _build(args, book: PriceBook) -> int:
    quote = load_quote(args.spec, book)
    output = args.output
    if output is None:
        suffix = ".html" if args.html else ".pdf"
        output = Path("out") / (args.spec.stem + suffix)
    want_html = args.html or output.suffix.lower() == ".html"

    if want_html:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render_html(quote, base_dir=Path.cwd()))
    else:
        render_pdf(quote, output, base_dir=Path.cwd())
    print(f"wrote {output}")
    return 0


def _check(args, book: PriceBook) -> int:
    quote = load_quote(args.spec, book)
    print(f"{quote.decedent} — {len(quote.options)} option(s)")
    for option in quote.options:
        print(f"\n  {option.title}")
        for line in option.lines:
            print(f"    {line.label:<44} {money(line.extended):>21}")
        if quote.apply_tax_to_totals:
            print(f"    {'Sales tax':<44} {money(option.tax(quote.tax_rate)):>21}")
            total = option.total_with_tax(quote.tax_rate)
        else:
            total = option.total
        print(f"    {'Estimated Total':<44} {money(total):>21}")
    return 0


def _items(args, book: PriceBook) -> int:
    selected = book.in_category(args.category) if args.category else list(book)
    if not selected:
        print(f"no items in category {args.category!r}", file=sys.stderr)
        return 1
    for item in sorted(selected, key=lambda i: (i.category, i.sku)):
        tax = "" if item.taxable else "  (non-taxable)"
        print(f"{item.sku:<26} {item.category:<10} {money(item.price):>21}  {item.display_name}{tax}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
