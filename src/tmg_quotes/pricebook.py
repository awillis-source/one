"""Loading and querying the price book.

The price book is the single source of truth for what things cost. It can be
kept as YAML (hand edited, supports images and captions) or as CSV exported
from a spreadsheet. Both load into the same :class:`PriceBook`.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional

import yaml

from .models import Item, Money, PriceBookError

CSV_COLUMNS = {
    "sku": ("sku", "code", "item code"),
    "name": ("name", "item", "description"),
    "price_low": ("price_low", "low", "min", "price low"),
    "price_high": ("price_high", "high", "max", "price high"),
    "price": ("price", "amount"),
    "category": ("category", "type"),
    "collection": ("collection", "series"),
    "image": ("image", "photo"),
    "caption": ("caption",),
    "taxable": ("taxable", "tax"),
    "notes": ("notes", "note"),
}


@dataclass
class PriceBook:
    """An indexed collection of priced items."""

    items: dict[str, Item]
    source: Optional[Path] = None
    effective_date: Optional[str] = None
    currency: str = "USD"

    def __iter__(self) -> Iterator[Item]:
        return iter(self.items.values())

    def __len__(self) -> int:
        return len(self.items)

    def get(self, sku: str) -> Item:
        """Look up an item by SKU, with a helpful error listing near matches."""
        try:
            return self.items[sku]
        except KeyError:
            raise PriceBookError(
                f"no price book item with sku {sku!r}."
                + _did_you_mean(sku, self.items)
            ) from None

    def in_category(self, category: str) -> list[Item]:
        return [i for i in self.items.values() if i.category == category]

    def categories(self) -> list[str]:
        return sorted({i.category for i in self.items.values()})

    @classmethod
    def load(cls, path: str | Path) -> "PriceBook":
        """Load a price book from a .yaml/.yml or .csv file."""
        path = Path(path)
        if not path.exists():
            raise PriceBookError(f"price book not found: {path}")
        if path.suffix.lower() in {".yaml", ".yml"}:
            return cls._load_yaml(path)
        if path.suffix.lower() in {".csv", ".tsv"}:
            return cls._load_csv(path)
        raise PriceBookError(
            f"unsupported price book format {path.suffix!r}; use .yaml or .csv"
        )

    @classmethod
    def _load_yaml(cls, path: Path, _seen: Optional[set[Path]] = None) -> "PriceBook":
        """Load a YAML price book, following any 'include:' files it names.

        Splitting the book by department (cemetery merchandise, caskets, …)
        keeps each file editable on its own; includes are resolved relative to
        the including file.
        """
        _seen = _seen or set()
        resolved = path.resolve()
        if resolved in _seen:
            raise PriceBookError(f"{path}: circular include")
        _seen.add(resolved)

        data = yaml.safe_load(path.read_text()) or {}
        if not isinstance(data, dict):
            raise PriceBookError(f"{path}: expected a mapping at the top level")

        includes = data.get("include") or []
        if not isinstance(includes, list):
            raise PriceBookError(f"{path}: 'include' must be a list of files")

        raw_items = data.get("items") or []
        if not isinstance(raw_items, list):
            raise PriceBookError(f"{path}: 'items' must be a list")
        if not raw_items and not includes:
            raise PriceBookError(f"{path}: expected a non-empty 'items' list")

        items = _index(_item_from_mapping(row, path) for row in raw_items)
        for included in includes:
            child = (path.parent / str(included)).resolve()
            if not child.exists():
                raise PriceBookError(f"{path}: included price book not found: {child}")
            for item in cls._load_yaml(child, _seen):
                if item.sku in items:
                    raise PriceBookError(
                        f"{child}: sku {item.sku!r} is already defined in {path}"
                    )
                items[item.sku] = item

        return cls(
            items=items,
            source=path,
            effective_date=data.get("effective_date"),
            currency=data.get("currency", "USD"),
        )

    @classmethod
    def _load_csv(cls, path: Path) -> "PriceBook":
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
        with path.open(newline="") as handle:
            reader = csv.DictReader(handle, delimiter=delimiter)
            if reader.fieldnames is None:
                raise PriceBookError(f"{path}: file has no header row")
            headers = {
                (name or "").strip().lower(): (name or "") for name in reader.fieldnames
            }
            rows = [_normalize_csv_row(row, headers, path) for row in reader]
        rows = [row for row in rows if row.get("sku")]
        if not rows:
            raise PriceBookError(f"{path}: no rows with a sku")
        return cls(items=_index(_item_from_mapping(r, path) for r in rows), source=path)


def _index(items: Iterable[Item]) -> dict[str, Item]:
    indexed: dict[str, Item] = {}
    for item in items:
        if item.sku in indexed:
            raise PriceBookError(f"duplicate sku in price book: {item.sku!r}")
        indexed[item.sku] = item
    return indexed


def _item_from_mapping(row: object, path: Path) -> Item:
    if not isinstance(row, dict):
        raise PriceBookError(f"{path}: each item must be a mapping, got {row!r}")
    sku = str(row.get("sku") or "").strip()
    if not sku:
        raise PriceBookError(f"{path}: item is missing a sku: {row!r}")
    name = str(row.get("name") or "").strip()
    if not name:
        raise PriceBookError(f"{path}: item {sku!r} is missing a name")

    try:
        price = _price_from_row(row)
    except ValueError as exc:
        raise PriceBookError(f"{path}: item {sku!r}: {exc}") from None

    return Item(
        sku=sku,
        name=name,
        price=price,
        category=str(row.get("category") or "merchandise").strip(),
        collection=_opt_str(row.get("collection")),
        image=_opt_str(row.get("image")),
        caption=_opt_str(row.get("caption")),
        taxable=_as_bool(row.get("taxable"), default=True),
        notes=_opt_str(row.get("notes")),
    )


def _price_from_row(row: dict) -> Money:
    if row.get("price_low") not in (None, "") or row.get("price_high") not in (None, ""):
        low = row.get("price_low")
        high = row.get("price_high")
        if low in (None, ""):
            low = high
        if high in (None, ""):
            high = low
        return Money.parse({"low": low, "high": high})
    if row.get("price") not in (None, ""):
        return Money.parse(row["price"])
    raise ValueError("no price given (need 'price', or 'price_low'/'price_high')")


def _normalize_csv_row(row: dict, headers: dict[str, str], path: Path) -> dict:
    """Map spreadsheet headers onto canonical field names, case-insensitively."""
    out: dict[str, object] = {}
    for field_name, aliases in CSV_COLUMNS.items():
        for alias in aliases:
            if alias in headers:
                value = row.get(headers[alias])
                if value not in (None, ""):
                    out[field_name] = value.strip() if isinstance(value, str) else value
                break
    return out


def _opt_str(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _as_bool(value: object, *, default: bool) -> bool:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "t"}


def _did_you_mean(sku: str, items: dict[str, Item]) -> str:
    import difflib

    close = difflib.get_close_matches(sku, list(items), n=3, cutoff=0.5)
    return f" Did you mean: {', '.join(close)}?" if close else ""
