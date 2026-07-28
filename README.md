# Commission Calculator

A real-time commission tracker that follows **Schedule A — Sales Guidelines
Commission Schedule, effective January 1, 2025**, and reconciles line-for-line
with the company's *Commission Auto Calc* sheet.

Every keystroke recalculates the month and is saved to the browser
immediately — there is no "save" button to forget.

## Running it

Open `index.html` in a browser. That's the whole install: no server, no build
step, no network. It works offline and from a USB stick.

To serve it over HTTP instead (useful for putting it on a phone):

```
npm start        # http://localhost:8080
```

## Tests

The rules engine is pure and separately testable:

```
npm test
```

65 tests cover every rate in the schedule, every exception, the bonus tiers
and their boundaries, the land sale bonus, splits, the AN chargeback, and the
2025 sales month calendar.

## How it is organised

| File | What it holds |
| --- | --- |
| `assets/rules.js` | The entire commission schedule as data plus the pure calculation functions. No DOM, no storage. |
| `assets/app.js` | UI, state, autosave, CSV/JSON export. |
| `assets/styles.css` | Styling, light and dark. |
| `test/rules.test.js` | Verification of the engine against the printed schedule. |
| `SCHEDULE-A.md` | The schedule transcribed, with every judgement call the engine makes written down. |

**If the schedule changes, edit `assets/rules.js` only.** The rate tables,
bonus tiers, financing options and sales calendar all live at the top of that
file as plain data, with the schedule's own wording in the comments. Update
the numbers, run `npm test`, and adjust the tests that legitimately changed.

## What it tracks

**Cemetery** — the nine financing options from the company sheet (`AN`,
`PN PIF`, `PN NO INT`, `PN ≤ 36 months`, `PN < 60 months`, `PN < 10% DP` and
their no-ACH variants), priced against Schedule A's property and designed
merchandise columns. Volume is entered the same way the company sheet lays it
out: ground, crypt, niche, other cemetery, and the O&C amount.

The financing option is **suggested** from the down payment and term, and
flagged if you pick something different — but you always have the final say,
since it is what gets keyed into the company sheet.

**Insurance** — NGL single pay, 3 year and 5 year with autopay, by age on the
date of issue. Cancelled and do-not-sell products are listed but warn and pay
zero.

**PN Trust** — by age on the contract date, with and without a bank draft,
including the chargeback to 4% / 2% when a trust turns AN within 30 days.

**Bonuses** — both monthly incentive bonuses with live progress toward the
next tier, the $100 land sale bonus for the first three qualifying preneed
contracts, and training pay when it beats commissions.

**Splits** — enter your share as a percentage. The contract's full commission
and your share are both shown and both exported.

## Your data

Everything is stored in this browser's local storage under
`commission-calculator-v1`. It is never sent anywhere.

That means it is tied to **this browser on this device**. Clearing site data,
using private browsing, or switching devices will lose it. Use
**Settings → Download backup** regularly; restoring a backup on another
device carries everything across.

Two exports:

- **Export CSV** — the current sales month in the company sheet's column
  order, ready to paste in and reconcile.
- **Backup** — complete JSON of every sale and setting.

## Things worth knowing

- **Sales months, not calendar months.** March 2025 runs 03/03 – 03/30. The
  2025 calendar is transcribed exactly from Schedule A. Other years are
  projected from its 5-4-4 pattern, labelled `(est.)`, and should be checked
  against the published schedule when it comes out — the real calendar shifts
  around holidays (August 2025 runs a day long for Labor Day).
- **Large sales** over $25,000 are capped at a 10% rate until Corporate sets
  the actual percentage, which you can enter under Advanced.
- **Bonus volume** caps at $25,000 per sale and excludes contracts with under
  10% down and no automatic payment setup.
- Bonuses are paid before the 30-day cancellation window closes on some
  contracts, so a paid bonus can still be reversed if a contract cancels.

This tool is an estimator built from the printed schedule. Corporate's
calculation is the one that pays. Where they disagree, they're right — and
it's worth finding out which rule differs.
