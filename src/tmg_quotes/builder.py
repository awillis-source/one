"""Build a :class:`Quote` from a YAML spec plus the price book.

A quote spec names the family and lists options; every priced line is a
reference to a price book SKU, so a price change in the book flows through to
every quote built afterwards. A line may override its label or quantity, but
never its price — that keeps quotes honest against the book.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Optional

import yaml

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

# Generic wording, since a quote may cover cemetery merchandise, caskets, or
# both. A quote that needs different wording sets its own 'footnotes:'.
DEFAULT_FOOTNOTES = [
    "Photos shown reflect the specific collections priced above; individual "
    "colors, wording, and artwork are customized at selection.",
    "Indiana sales tax of 7% applies to merchandise only.",
]


class QuoteSpecError(Exception):
    """Raised when a quote spec is malformed."""


def load_quote(path: str | Path, book: PriceBook) -> Quote:
    """Read a quote spec file and resolve it against the price book."""
    path = Path(path)
    if not path.exists():
        raise QuoteSpecError(f"quote spec not found: {path}")
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise QuoteSpecError(f"{path}: expected a mapping at the top level")
    return build_quote(data, book, source=path)


def build_quote(
    spec: dict, book: PriceBook, *, source: Optional[Path] = None
) -> Quote:
    """Resolve a quote spec mapping against the price book."""
    where = f"{source}: " if source else ""

    decedent = str(spec.get("decedent") or "").strip()
    if not decedent:
        raise QuoteSpecError(f"{where}quote needs a 'decedent' name")

    raw_options = spec.get("options")
    if not isinstance(raw_options, list) or not raw_options:
        raise QuoteSpecError(f"{where}quote needs a non-empty 'options' list")

    options = [_build_option(o, book, i, where) for i, o in enumerate(raw_options, 1)]

    tax_rate = _rate(spec.get("tax_rate", "0.07"), f"{where}tax_rate")

    return Quote(
        decedent=decedent,
        options=options,
        subtitle=_opt_str(spec.get("subtitle")),
        prepared_for=_opt_str(spec.get("prepared_for")),
        advisor=_opt_str(spec.get("advisor")),
        organization=str(spec.get("organization") or "Tippecanoe Memory Gardens"),
        logo=_opt_str(spec.get("logo")),
        tax_rate=tax_rate,
        apply_tax_to_totals=bool(spec.get("apply_tax_to_totals", False)),
        footnotes=_footnotes(spec),
        financing=_build_financing(spec.get("financing"), where),
        quote_date=_opt_str(spec.get("quote_date")),
        valid_days=spec.get("valid_days"),
    )


def _build_option(raw: object, book: PriceBook, index: int, where: str) -> Option:
    if not isinstance(raw, dict):
        raise QuoteSpecError(f"{where}option {index} must be a mapping")
    title = str(raw.get("title") or "").strip()
    if not title:
        raise QuoteSpecError(f"{where}option {index} needs a 'title'")

    raw_lines = raw.get("items") or raw.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        raise QuoteSpecError(f"{where}option {index} ({title}) needs an 'items' list")

    lines = [_build_line(line, book, title, where) for line in raw_lines]

    # An option's photo defaults to the photo on its first pictured item, so a
    # spec usually does not have to name one. 'image_from' picks a different
    # line's photo by SKU; 'image' points at a file directly.
    image = _opt_str(raw.get("image"))
    caption = _opt_str(raw.get("caption"))
    feature_sku = _opt_str(raw.get("image_from"))
    if feature_sku:
        featured = next((l for l in lines if l.item.sku == feature_sku), None)
        if featured is None:
            raise QuoteSpecError(
                f"{where}option {option!r}: image_from {feature_sku!r} is not one of "
                "this option's items"
            )
        image = image or featured.item.image
        caption = caption or featured.item.caption
    if image is None:
        for line in lines:
            if line.item.image:
                image = line.item.image
                break
    if caption is None and image is not None:
        caption = next(
            (l.item.caption for l in lines if l.item.image == image and l.item.caption),
            None,
        )

    return Option(
        title=title,
        lines=lines,
        subtitle=_opt_str(raw.get("subtitle")),
        image=image,
        caption=caption,
    )


def _build_line(raw: object, book: PriceBook, option: str, where: str) -> LineItem:
    if isinstance(raw, str):
        raw = {"sku": raw}
    if not isinstance(raw, dict):
        raise QuoteSpecError(f"{where}option {option!r}: bad line {raw!r}")

    quantity = int(raw.get("quantity", 1))
    if quantity < 1:
        raise QuoteSpecError(f"{where}option {option!r}: quantity must be at least 1")

    sku = _opt_str(raw.get("sku"))
    if sku:
        try:
            item = book.get(sku)
        except PriceBookError as exc:
            raise QuoteSpecError(f"{where}option {option!r}: {exc}") from None
    else:
        item = _adhoc_item(raw, option, where)

    return LineItem(
        item=item, quantity=quantity, label_override=_opt_str(raw.get("label"))
    )


def _adhoc_item(raw: dict, option: str, where: str) -> Item:
    """A one-off line priced in the spec itself (allowances, credits, fees).

    Anything the cemetery sells regularly belongs in the price book instead.
    """
    name = _opt_str(raw.get("name"))
    if not name:
        raise QuoteSpecError(
            f"{where}option {option!r}: a line needs either a 'sku' or a 'name' + 'price'"
        )
    if raw.get("price") in (None, "") and raw.get("price_low") in (None, ""):
        raise QuoteSpecError(f"{where}option {option!r}: ad-hoc line {name!r} needs a 'price'")
    try:
        price = (
            Money.parse({"low": raw["price_low"], "high": raw.get("price_high", raw.get("price_low"))})
            if raw.get("price_low") not in (None, "")
            else Money.parse(raw["price"])
        )
    except ValueError as exc:
        raise QuoteSpecError(f"{where}option {option!r}: {name!r}: {exc}") from None
    return Item(
        sku=f"adhoc:{name}",
        name=name,
        price=price,
        category=str(raw.get("category") or "other"),
        taxable=bool(raw.get("taxable", True)),
    )


def _build_financing(raw: object, where: str) -> Optional[Financing]:
    if raw in (None, False):
        return None
    if not isinstance(raw, dict):
        raise QuoteSpecError(f"{where}'financing' must be a mapping")

    percent = _rate(raw.get("down_payment_percent", "0.12"), f"{where}down_payment_percent")

    plans = []
    for raw_plan in raw.get("plans") or []:
        if not isinstance(raw_plan, dict):
            raise QuoteSpecError(f"{where}each financing plan must be a mapping")
        months = raw_plan.get("months")
        if not isinstance(months, int) or months <= 0:
            raise QuoteSpecError(f"{where}financing plan needs a positive 'months'")
        apr = raw_plan.get("apr")
        plans.append(
            FinancingPlan(
                months=months,
                label=str(raw_plan.get("label") or f"{months}-Month Plan"),
                apr=None if apr in (None, "") else _rate(apr, f"{where}plan apr"),
                rate_label=_opt_str(raw_plan.get("rate_label")),
                description=_opt_str(raw_plan.get("description"))
                or _default_plan_description(months),
            )
        )

    return Financing(
        down_payment_percent=percent,
        plans=plans,
        down_payment_note=_opt_str(raw.get("down_payment_note"))
        or f"{_percent_text(percent)} of contract total, due at signing",
        notes=[str(n) for n in (raw.get("notes") or [])],
        show_payment_table=bool(raw.get("show_payment_table", False)),
    )


def _default_plan_description(months: int) -> str:
    if months % 12 == 0:
        years = months // 12
        span = "1 year" if years == 1 else f"{years} years"
    else:
        span = f"{months} months"
    return f"Remaining balance paid in equal monthly installments over {span}."


def _footnotes(spec: dict) -> list[str]:
    raw = spec.get("footnotes")
    if raw is None:
        return list(DEFAULT_FOOTNOTES)
    if not isinstance(raw, list):
        raise QuoteSpecError("'footnotes' must be a list")
    return [str(n) for n in raw]


def _rate(value: object, label: str) -> Decimal:
    """Read a rate given either as a fraction (0.089) or a percent ("8.90%")."""
    if isinstance(value, str) and value.strip().endswith("%"):
        return Decimal(value.strip().rstrip("%")) / Decimal(100)
    try:
        rate = Decimal(str(value))
    except Exception:
        raise QuoteSpecError(f"{label}: not a number: {value!r}") from None
    if rate > 1:  # someone wrote 8.9 meaning 8.9%
        rate = rate / Decimal(100)
    if not 0 <= rate <= 1:
        raise QuoteSpecError(f"{label}: rate out of range: {value!r}")
    return rate


def _percent_text(rate: Decimal) -> str:
    percent = rate * 100
    text = f"{percent.normalize():f}"
    return f"{text}%"


def _opt_str(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None
