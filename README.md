# Tippecanoe Memory Gardens — quote builder

Builds family quote PDFs from the price book. A quote is a short YAML file that
names the family and lists the options; every price comes from the price book,
so a price change is made in one place and flows into every quote built after.

The output is a page-for-page match of the Schutz reference quote: same Letter
geometry, same palette, same type, calculated totals, and a payment options
page.

```
tmg-quote build quotes/schutz.yaml -o out/schutz.pdf
```

## Install

```bash
pip install -e ".[dev]"      # Jinja2, PyYAML, Playwright, pytest
playwright install chromium  # only if Chromium is not already provisioned
```

PDF output prints through headless Chromium. If the machine already has a
Playwright browser (`PLAYWRIGHT_BROWSERS_PATH`), it is found automatically;
otherwise set `TMG_CHROMIUM` to a Chromium binary.

## Commands

| Command | What it does |
| --- | --- |
| `tmg-quote build <spec>` | Render a quote to `out/<name>.pdf` (`--html` for HTML, `-o` for another path) |
| `tmg-quote check <spec>` | Validate a spec and print every line and total — no file written |
| `tmg-quote items` | List the price book (`-c marker` to filter by category) |

All commands take `-p/--price-book` (default `data/price_book.yaml`).

## The price book

`data/price_book.yaml` is the source of truth. Each item:

```yaml
- sku: VAULT-AEGEAN          # how quotes refer to this item
  name: Cremation Vault
  collection: Aegean         # prints as "Cremation Vault (Aegean)"
  category: vault            # vault | marker | service | ...
  price_low: 1007            # a range, for items priced at selection
  price_high: 1328
  image: assets/products/aegean-cremation-vault.png
  caption: Aegean cremation vault — shown in white marble finish
  taxable: true              # false for services; Indiana taxes merchandise only
```

Use `price:` instead of `price_low`/`price_high` for a single figure. A range
prints as `$1,007 – $1,328`; a single figure prints as `$995`.

The book is split by department. `data/price_book.yaml` holds cemetery
merchandise and services and pulls in the rest:

```yaml
include:
  - caskets.yaml
```

Included paths are relative to the including file, a SKU may only be defined
once across all of them, and circular includes are refused.

### Caskets

`data/caskets.yaml` holds all 254 caskets — 12 collections, $3,195 to $42,095 —
with a photo each in `assets/caskets/`. It is generated, not hand-written:

```bash
python scripts/import_casket_catalog.py <casket-gallery.html>
```

The importer flags rather than fixes what the source got wrong, so nothing bad
reaches a family quote silently. Two things currently need a human pass:

- **108 truncated names** — the source catalog cut names at the display width
  (`Victoriaville Mahogany Dar…`). Each carries a "confirm full finish name"
  note.
- **25 material/collection mismatches** — e.g. four caskets filed under
  *Bronze & Copper* with a material of *Stainless Steel*, and nine *20 Gauge
  Non-Gasketed* under *Value*. Each carries a note naming the conflict.

Find them with `grep -n "confirm full finish name\|verify collection"
data/caskets.yaml`. Fixing one is a plain edit to that file; re-running the
importer overwrites it, so fix the source catalog or keep the edits.

A CSV export from a spreadsheet works too — `tmg-quote -p pricing.csv build …`.
Headers are matched case-insensitively and common names are accepted
(`sku`/`code`/`item code`, `low`/`min`/`price_low`, and so on).

> The five cemetery items in `data/price_book.yaml` (vault, open & close, the
> markers) were reconstructed from the Schutz quote so the reference build
> reproduces exactly. Replace them with the real cemetery price book export.
> The casket catalog is real.

## Writing a quote

```yaml
decedent: Carole Jeannette Schutz
subtitle: Cremation Interment Options
prepared_for: Jill Lang & Jan Richardson
advisor: Alissa Willis, Family Service Advisor
logo: assets/logo.png

options:
  - title: Option 1 — Cremation Vault + Bronze Headstone
    subtitle: Includes vault, open & close, and bronze marker
    items:
      - VAULT-AEGEAN
      - SVC-OC-CREMATION
      - MRK-BRONZE-CLASSIC
```

Each option prints as a photo beside a price table with an **Estimated Total**.
The photo and caption come from the first pictured item; `image_from: <SKU>`
features a different one, and `image:`/`caption:` set them outright.

A line may be a bare SKU or a mapping with `quantity:` or `label:`. Anything
sold regularly belongs in the price book; a one-off (an allowance, a credit)
can be priced inline with `name:` and `price:`.

Footnotes default to generic wording covering both cemetery merchandise and
caskets. `quotes/schutz.yaml` sets its own `footnotes:` to keep the exact
wording of the reference quote.

### Tax

`tax_rate` defaults to 7%, and items marked `taxable: false` (services) are
excluded. The reference quote states tax in a footnote rather than adding it to
the totals, which is the default. Set `apply_tax_to_totals: true` to add a
sales tax line to every option instead.

### Payment options

The `financing:` block prints the second page:

```yaml
financing:
  down_payment_percent: 12%
  show_payment_table: false
  plans:
    - months: 12
      apr: 0%
    - months: 36
      rate_label: Fixed Rate    # no APR on file, so no payment is calculated
    - months: 60
      apr: 8.90%
```

With `show_payment_table: true`, each option gets a table of down payment,
amount financed, and monthly payment per plan, amortized from the low end of
that option's total. Plans with no APR keep printing "Rate confirmed at
signing" rather than showing an invented figure. Omit `financing:` entirely and
the payment page is left out.

Add `signing_date: 2026-08-11` and the table gains a **Paid In Full** date per
plan. Installments fall on the same day of the month, starting one month after
signing, and a due date on the 31st moves to the last day of a shorter month.

The last installment is adjusted to the cent so the payments total the contract
exactly — level payments round, so twelve of $1,448.65 would otherwise overshoot
a $17,383.78 balance by two cents.

## Layout

Geometry is calibrated against the reference quote and asserted in
`tests/test_render.py` — the logo, header rule, footer rule, and option blocks
must land within 2pt of the original. The repeated header and footer are
printed into the page margins by Chromium, so quotes with more options paginate
correctly and page numbers stay right.

## Tests

```bash
python -m pytest
```

The PDF tests skip themselves when no Chromium is available.
