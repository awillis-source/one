#!/usr/bin/env python3
"""Import the casket catalog into the price book.

The casket selection gallery embeds the catalog as a `window.CASKET_DATA`
JSON blob: name, collection, material, price, and a photo per casket. This
turns that into a price book file plus an image per casket, so caskets can be
quoted the same way cemetery merchandise is.

    python scripts/import_casket_catalog.py gallery.html

Re-running overwrites data/caskets.yaml and assets/caskets/. Prices are taken
from the source verbatim; nothing is inferred.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

CASKET_DATA_RE = re.compile(r"window\.CASKET_DATA\s*=\s*(\{.*?\})\s*;?\s*</script>", re.S)
DATA_URI_RE = re.compile(r"^data:(image/(?P<ext>[a-z]+));base64,(?P<payload>.+)$", re.S)

REPO = Path(__file__).resolve().parent.parent


def extract_data(path: Path) -> dict:
    """Pull the CASKET_DATA object out of an HTML page (or read raw JSON)."""
    text = path.read_text(errors="replace")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    match = CASKET_DATA_RE.search(text)
    if not match:
        raise SystemExit(f"{path}: no window.CASKET_DATA found")
    return json.loads(match.group(1))


def write_image(casket: dict, out_dir: Path) -> str | None:
    match = DATA_URI_RE.match(casket.get("img") or "")
    if not match:
        return None
    ext = "jpg" if match.group("ext") == "jpeg" else match.group("ext")
    target = out_dir / f"{casket['id']}.{ext}"
    target.write_bytes(base64.b64decode(match.group("payload")))
    return str(target.relative_to(REPO))


def sku_for(casket: dict) -> str:
    return "CKT-" + casket["id"].upper()


def material_fits(material: str, blurb: str) -> bool:
    """Is this material one the collection covers?

    Compared token by token, because a collection blurb compresses its
    materials ("18 & 20 Gauge Steel" covers a material of "18 Gauge") and a
    plain substring test would call that a mismatch.
    """
    if not blurb:
        return True
    blurb_tokens = set(re.findall(r"[a-z0-9-]+", blurb.lower()))
    material_tokens = set(re.findall(r"[a-z0-9-]+", material.lower()))
    return bool(material_tokens) and material_tokens <= blurb_tokens


def yaml_str(value: str) -> str:
    """Quote a scalar for YAML, escaping what needs escaping."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="gallery HTML (or a JSON dump)")
    parser.add_argument(
        "-o", "--output", type=Path, default=REPO / "data/caskets.yaml"
    )
    parser.add_argument(
        "--image-dir", type=Path, default=REPO / "assets/caskets"
    )
    parser.add_argument(
        "--no-images", action="store_true", help="write prices only"
    )
    args = parser.parse_args(argv)

    data = extract_data(args.source)
    caskets = data.get("caskets") or []
    if not caskets:
        raise SystemExit(f"{args.source}: no caskets in the catalog")

    if not args.no_images:
        args.image_dir.mkdir(parents=True, exist_ok=True)

    lines = [
        "# Casket price book — imported from the casket selection gallery.",
        "#",
        f"# Source: {data.get('source', 'unknown')}",
        f"# {len(caskets)} caskets across {len(data.get('collections') or [])} collections.",
        "# Regenerate with: python scripts/import_casket_catalog.py <gallery.html>",
        "#",
        "# Names ending in '…' were truncated in the source catalog and carry a",
        "# 'confirm full name' note — they need a human pass before they go on a quote.",
        "",
        "items:",
    ]

    # Each collection advertises the materials it covers; a casket whose
    # material is not among them is a source inconsistency worth flagging
    # rather than quietly importing.
    blurbs = {
        c.get("name"): (c.get("blurb") or "") for c in (data.get("collections") or [])
    }

    truncated = 0
    mismatched = 0
    for casket in sorted(caskets, key=lambda c: (c.get("collection", ""), c["price"])):
        image = None if args.no_images else write_image(casket, args.image_dir)
        collection = casket.get("collection") or None
        material = casket.get("material") or None

        notes = []
        for label in (material, casket.get("family")):
            if label and label not in notes:
                notes.append(label)
        if casket.get("truncated"):
            truncated += 1
            notes.append("name truncated in source catalog — confirm full finish name")
        blurb = blurbs.get(collection, "")
        if material and not material_fits(material, blurb):
            mismatched += 1
            notes.append(
                f"source lists this under {collection} "
                f"({blurb}) — verify collection/material pairing"
            )

        lines.append(f"  - sku: {sku_for(casket)}")
        lines.append(f"    name: {yaml_str(casket['name'])}")
        lines.append("    category: casket")
        if collection:
            lines.append(f"    collection: {yaml_str(collection)}")
        lines.append(f"    price: {casket['price']}")
        if image:
            lines.append(f"    image: {image}")
        if collection and material:
            lines.append(
                f"    caption: {yaml_str(f'{collection} collection — {material}')}"
            )
        if notes:
            lines.append(f"    notes: {yaml_str(' · '.join(notes))}")
        lines.append("")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines))

    print(f"wrote {args.output} — {len(caskets)} caskets")
    if not args.no_images:
        print(f"wrote {args.image_dir} — one photo per casket")
    if truncated:
        print(f"note: {truncated} names are truncated in the source and need review")
    if mismatched:
        print(
            f"note: {mismatched} caskets list a material their collection does not "
            "cover — flagged in notes for review"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
