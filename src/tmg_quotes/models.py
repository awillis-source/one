"""Domain model for price book items, quotes, and financing."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

_RANGE_SEP_RE = re.compile(r"\s*(?:-|–|—|to)\s*")


class PriceBookError(Exception):
    """Raised when the price book is malformed or a lookup fails."""


@dataclass(frozen=True)
class Money:
    """A price that may be a single figure or a low/high range.

    Cemetery merchandise is quoted as a range because final price depends on
    size, color, and lettering chosen at selection. A single-figure price
    (services such as open & close) is stored as a range where low == high.
    """

    low: Decimal
    high: Decimal

    def __post_init__(self) -> None:
        if self.low < 0 or self.high < 0:
            raise ValueError("prices may not be negative")
        if self.high < self.low:
            raise ValueError(f"price range is inverted: {self.low} > {self.high}")

    @classmethod
    def parse(cls, value: object) -> "Money":
        """Build a Money from a scalar (995), a mapping, or a "1007-1328" string."""
        if isinstance(value, Money):
            return value
        if isinstance(value, dict):
            if "low" not in value or "high" not in value:
                raise ValueError("price mapping needs both 'low' and 'high'")
            return cls(_dec(value["low"]), _dec(value["high"]))
        if isinstance(value, str) and _RANGE_SEP_RE.search(value):
            low, high = _RANGE_SEP_RE.split(value, maxsplit=1)
            return cls(_dec(low), _dec(high))
        amount = _dec(value)
        return cls(amount, amount)

    @property
    def is_range(self) -> bool:
        return self.low != self.high

    def __add__(self, other: "Money") -> "Money":
        return Money(self.low + other.low, self.high + other.high)

    def scaled(self, factor: Decimal) -> "Money":
        return Money(self.low * factor, self.high * factor)


@dataclass(frozen=True)
class Item:
    """One priced line available in the price book."""

    sku: str
    name: str
    price: Money
    category: str = "merchandise"
    collection: Optional[str] = None
    image: Optional[str] = None
    caption: Optional[str] = None
    taxable: bool = True
    notes: Optional[str] = None

    @property
    def display_name(self) -> str:
        """Name as it appears on a quote line, e.g. "Cremation Vault (Aegean)"."""
        if self.collection:
            return f"{self.name} ({self.collection})"
        return self.name


@dataclass(frozen=True)
class LineItem:
    """A price book item placed on a quote, with quantity applied."""

    item: Item
    quantity: int = 1
    label_override: Optional[str] = None

    @property
    def label(self) -> str:
        base = self.label_override or self.item.display_name
        return f"{base} x{self.quantity}" if self.quantity != 1 else base

    @property
    def extended(self) -> Money:
        return self.item.price.scaled(Decimal(self.quantity))


@dataclass
class Option:
    """One package the family can choose between."""

    title: str
    lines: list[LineItem]
    subtitle: Optional[str] = None
    image: Optional[str] = None
    caption: Optional[str] = None

    @property
    def total(self) -> Money:
        total = Money(Decimal(0), Decimal(0))
        for line in self.lines:
            total += line.extended
        return total

    @property
    def taxable_total(self) -> Money:
        total = Money(Decimal(0), Decimal(0))
        for line in self.lines:
            if line.item.taxable:
                total += line.extended
        return total

    def tax(self, rate: Decimal) -> Money:
        return self.taxable_total.scaled(rate)

    def total_with_tax(self, rate: Decimal) -> Money:
        return self.total + self.tax(rate)


@dataclass(frozen=True)
class FinancingPlan:
    """An installment plan offered on the balance after the down payment."""

    months: int
    label: str
    apr: Optional[Decimal] = None
    rate_label: Optional[str] = None
    description: Optional[str] = None

    @property
    def display_rate(self) -> str:
        if self.rate_label:
            return self.rate_label
        if self.apr is None:
            return ""
        if self.apr == 0:
            return "0% APR"
        return f"{self.apr * 100:.2f}% APR"


@dataclass
class Financing:
    """Down payment terms plus the available installment plans."""

    down_payment_percent: Decimal
    plans: list[FinancingPlan] = field(default_factory=list)
    down_payment_note: Optional[str] = None
    notes: list[str] = field(default_factory=list)
    show_payment_table: bool = False


@dataclass
class Quote:
    """A complete quote document ready to render."""

    decedent: str
    options: list[Option]
    subtitle: Optional[str] = None
    prepared_for: Optional[str] = None
    advisor: Optional[str] = None
    organization: str = "Tippecanoe Memory Gardens"
    logo: Optional[str] = None
    tax_rate: Decimal = Decimal("0.07")
    apply_tax_to_totals: bool = False
    footnotes: list[str] = field(default_factory=list)
    financing: Optional[Financing] = None
    quote_date: Optional[str] = None
    valid_days: Optional[int] = None

    @property
    def header_line(self) -> str:
        """The italic line under the decedent's name."""
        parts = [p for p in (self.subtitle, self.prepared_for) if p]
        if self.prepared_for and parts and parts[-1] == self.prepared_for:
            parts[-1] = f"Prepared for {self.prepared_for}"
        # Non-breaking spaces keep the wide spacing around the separator that
        # HTML would otherwise collapse.
        return "  ·  ".join(parts)


def _dec(value: object) -> Decimal:
    """Coerce a YAML scalar to Decimal, tolerating "$1,007" style strings."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise ValueError("boolean is not a price")
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        cleaned = value.strip().replace("$", "").replace(",", "").replace("_", "")
        if not cleaned:
            raise ValueError("empty price")
        try:
            return Decimal(cleaned)
        except Exception as exc:  # pragma: no cover - message clarity only
            raise ValueError(f"could not read price {value!r}") from exc
    raise ValueError(f"could not read price {value!r}")
