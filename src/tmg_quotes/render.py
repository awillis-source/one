"""Render a quote to HTML, and from there to PDF via headless Chromium.

The HTML is self-contained: the stylesheet is inlined and every image is
embedded as a data URI, so a rendered quote can be emailed or archived as a
single file, and Chromium's print pipeline needs no local file access.
"""

from __future__ import annotations

import base64
import mimetypes
from decimal import Decimal
from pathlib import Path
from typing import Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .finance import payment_schedule
from .models import Money, Quote

PACKAGE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = PACKAGE_DIR / "templates"
STATIC_DIR = PACKAGE_DIR / "static"

EN_DASH = "–"

# Page geometry, in points, taken from the reference quote.
PAGE_MARGINS = {"top": "1.35in", "bottom": "0.62in", "left": "0.75in", "right": "0.75in"}

# Chromium does not place header/footer templates at the top-left of the margin
# box: it insets the header downward and the footer upward. These offsets undo
# that, so the coordinates below are true distances from the page edge, matching
# the reference quote (logo at 34.6pt, header rule at 91.6pt, footer rule at
# 752.4pt). Verified by measuring the generated PDF; see tests/test_render.py.
HEADER_OFFSET_PT = 14.93
FOOTER_OFFSET_PT = 12.15


class RenderError(Exception):
    """Raised when a quote cannot be rendered."""


def money(value: Money) -> str:
    """Format a price the way the quote shows it: "$995" or "$1,007 – $1,328"."""
    if value.is_range:
        return f"{_dollars(value.low)} {EN_DASH} {_dollars(value.high)}"
    return _dollars(value.low)


def _dollars(amount: Decimal) -> str:
    quantized = amount.quantize(Decimal("1")) if amount == amount.to_integral_value() else amount.quantize(Decimal("0.01"))
    return f"${quantized:,}"


def data_uri(path: str | Path, *, base_dir: Optional[Path] = None) -> str:
    """Inline a local image as a data URI; pass through anything already inline."""
    text = str(path)
    if text.startswith(("data:", "http://", "https://")):
        return text
    resolved = Path(text)
    if not resolved.is_absolute() and base_dir is not None:
        resolved = base_dir / resolved
    if not resolved.exists():
        raise RenderError(f"image not found: {resolved}")
    mime = mimetypes.guess_type(resolved.name)[0] or "image/png"
    encoded = base64.b64encode(resolved.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _environment() -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["money"] = money
    return env


def render_html(quote: Quote, *, base_dir: Optional[Path] = None) -> str:
    """Render the quote body (everything except the repeated header/footer)."""
    base_dir = Path(base_dir) if base_dir else Path.cwd()

    images: dict[str, str] = {}
    for option in quote.options:
        if option.image:
            images[option.image] = data_uri(option.image, base_dir=base_dir)

    schedules = None
    if quote.financing and quote.financing.show_payment_table:
        schedules = [
            (option, payment_schedule(option.total, quote.financing))
            for option in quote.options
        ]

    template = _environment().get_template("quote.html.j2")
    return template.render(
        quote=quote,
        images=images,
        css=(STATIC_DIR / "quote.css").read_text(),
        schedules=schedules,
        tax_percent=_percent_text(quote.tax_rate),
    )


def _percent_text(rate: Decimal) -> str:
    percent = (rate * 100).normalize()
    return f"{percent:f}%"


def _chrome_header(quote: Quote, base_dir: Path) -> str:
    """Header drawn in the top margin of every page: logo plus a rule."""
    logo_top = 34.6 - HEADER_OFFSET_PT
    rule_top = 91.6 - HEADER_OFFSET_PT
    logo = ""
    if quote.logo:
        logo = (
            f'<img src="{data_uri(quote.logo, base_dir=base_dir)}" '
            f'style="position:absolute;left:223.2pt;top:{logo_top:.2f}pt;'
            'width:165.6pt;height:45.5pt;">'
        )
    return (
        '<div style="position:relative;width:100%;height:100%;margin:0;padding:0;'
        '-webkit-print-color-adjust:exact;">'
        f"{logo}"
        f'<div style="position:absolute;left:54pt;top:{rule_top:.2f}pt;width:504pt;'
        'border-top:1pt solid #345C9A;"></div>'
        "</div>"
    )


def _chrome_footer(quote: Quote) -> str:
    """Footer drawn in the bottom margin: rule, page numbers, advisor."""
    advisor = quote.advisor or ""
    rule_top = 7.4 + FOOTER_OFFSET_PT
    text_top = 12.0 + FOOTER_OFFSET_PT
    return (
        '<div style="position:relative;width:100%;height:100%;margin:0;padding:0;'
        'font-family:\'Liberation Serif\',\'Times New Roman\',Times,serif;'
        '-webkit-print-color-adjust:exact;">'
        f'<div style="position:absolute;left:54pt;top:{rule_top:.2f}pt;width:504pt;'
        'border-top:0.75pt solid #B9C6DC;"></div>'
        f'<div style="position:absolute;left:54pt;top:{text_top:.2f}pt;font-size:9pt;'
        'color:#1A1A1A;">Page <span class="pageNumber"></span> of '
        '<span class="totalPages"></span></div>'
        f'<div style="position:absolute;right:54pt;top:{text_top:.2f}pt;font-size:9pt;'
        f'font-style:italic;color:#345C9A;">{advisor}</div>'
        "</div>"
    )


def _chromium_executable() -> Optional[str]:
    """Find a Chromium to print with.

    Playwright normally manages its own browser download, but a provisioned
    environment often ships one whose build number does not match the
    installed Playwright. Prefer an explicit TMG_CHROMIUM, then a browser in
    PLAYWRIGHT_BROWSERS_PATH, then let Playwright pick its own.
    """
    import glob
    import os

    explicit = os.environ.get("TMG_CHROMIUM")
    if explicit and Path(explicit).exists():
        return explicit

    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if not root:
        return None
    candidates = [Path(root) / "chromium", *sorted(
        Path(p) for p in glob.glob(str(Path(root) / "chromium-*" / "chrome-linux" / "chrome"))
    )]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def render_pdf(
    quote: Quote, output: str | Path, *, base_dir: Optional[Path] = None
) -> Path:
    """Render the quote to a PDF using the bundled headless Chromium."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RenderError(
            "PDF output needs Playwright. Install it with 'pip install playwright' "
            "(the browser itself is already provisioned in this environment)."
        ) from exc

    base_dir = Path(base_dir) if base_dir else Path.cwd()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    html = render_html(quote, base_dir=base_dir)

    launch_kwargs: dict = {}
    executable = _chromium_executable()
    if executable:
        launch_kwargs["executable_path"] = executable

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch_kwargs)
        try:
            page = browser.new_page()
            page.set_content(html, wait_until="load")
            page.pdf(
                path=str(output),
                format="Letter",
                print_background=True,
                display_header_footer=True,
                header_template=_chrome_header(quote, base_dir),
                footer_template=_chrome_footer(quote),
                margin=PAGE_MARGINS,
            )
        finally:
            browser.close()
    return output
