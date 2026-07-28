/*
 * Schedule A — Sales Guidelines Commission Schedule
 * Effective January 1, 2025 (version 01/01/2025)
 *
 * Pure rules engine. No DOM access, no storage, no side effects.
 * Loadable as a classic <script> (exposes globalThis.CommissionRules)
 * or as a CommonJS module (for `node --test`).
 */
;(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (root) { root.CommissionRules = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEDULE_VERSION = 'Schedule A — effective 01/01/2025';

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  function num(v) {
    if (typeof v === 'number') { return isFinite(v) ? v : 0; }
    var n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }

  function pct(rate, amount) { return round2(num(amount) * (num(rate) / 100)); }

  /* ------------------------------------------------------------------ *
   * CEMETERY COMMISSIONS
   *
   *                                          Property   Property   Desg.Mdse  Desg.Mdse
   *  LEAD SOURCE                             (w/ ACH)   (no ACH)   (w/ ACH)   (no ACH)
   *  At Need                                    N/A       10%        N/A        10%
   *  Pre need - paid in full (no terms)         N/A       20%        N/A        16%
   *  Pre need - 20%+ down (terms <= 24 mo)      18%       16%        14%        12%
   *      or 12%+ down and up to 12 months
   *  Pre need - terms of 25 - 36 months         18%       16%        14%        12%
   *  Pre need - terms of 37 - 60 months         16%       14%        12%        10%
   *  Pre need - under 10% down (any terms
   *      up to 60 months)                       12%        0%         8%         0%
   *
   *  `null` == "N/A" on the printed schedule. N/A means the ACH/no-ACH
   *  distinction does not apply to that row (an at-need or paid-in-full
   *  sale has no draft), so the engine falls back to the without-ACH figure.
   * ------------------------------------------------------------------ */

  var CEMETERY_LEAD_SOURCES = [
    {
      id: 'at_need',
      label: 'At Need',
      preneed: false,
      propertyAch: null, propertyNoAch: 10,
      merchAch: null, merchNoAch: 10
    },
    {
      id: 'pn_paid_full',
      label: 'Pre need — paid in full (no terms)',
      preneed: true,
      propertyAch: null, propertyNoAch: 20,
      merchAch: null, merchNoAch: 16
    },
    {
      id: 'pn_short_terms',
      label: 'Pre need — 20%+ down (terms up to 24 mo) or 12%+ down and up to 12 mo',
      preneed: true,
      propertyAch: 18, propertyNoAch: 16,
      merchAch: 14, merchNoAch: 12
    },
    {
      id: 'pn_25_36',
      label: 'Pre need — terms of 25 - 36 months',
      preneed: true,
      propertyAch: 18, propertyNoAch: 16,
      merchAch: 14, merchNoAch: 12
    },
    {
      id: 'pn_37_60',
      label: 'Pre need — terms of 37 - 60 months',
      preneed: true,
      propertyAch: 16, propertyNoAch: 14,
      merchAch: 12, merchNoAch: 10
    },
    {
      id: 'pn_under_10',
      label: 'Pre need — under 10% down (any terms up to 60 months)',
      preneed: true,
      propertyAch: 12, propertyNoAch: 0,
      merchAch: 8, merchNoAch: 0
    }
  ];

  var CEMETERY_BY_ID = {};
  CEMETERY_LEAD_SOURCES.forEach(function (r) { CEMETERY_BY_ID[r.id] = r; });

  /* Cemetery Commission Exceptions, verbatim from Schedule A. */
  var UNDESIGNED_MERCH_REDUCTION = 5;   // "same percentages listed less 5% to a minimum of 0%"
  var PN_INTERMENT_FEE_RATE = 5;        // "PN Interment Authorization Fees (O/Cs) have a commission rate of 5%"
  var AN_INTERMENT_FEE_RATE = 0;        // "no commissions or volume on AN Interment Authorization Fees (O/C's)"
  var UNLINED_VAULT_RATE = 0;           // "Unlined vaults will be paid at 0% comm."
  var MAX_TERM_MONTHS = 60;             // "no contracts allowed to be written for longer than 60 months"
  var LARGE_SALE_THRESHOLD = 25000;     // "maximum 10% commission rate on large sales over $25,000"
  var LARGE_SALE_MAX_RATE = 10;

  /*
   * Line item types, keyed to the columns on the company's Commission Auto
   * Calc sheet: property volume is tracked separately for ground, crypt and
   * niche, everything else rolls into "other cemetery volume", and the O&C
   * (opening & closing / interment authorization) fee is its own column.
   *
   * `rateClass` selects which Schedule A column the item is priced from.
   */
  var CEMETERY_ITEM_TYPES = [
    { id: 'property_ground', label: 'Property volume (ground)', short: 'Ground', rateClass: 'property', rightOfBurial: true },
    { id: 'property_crypt', label: 'Property volume (crypt)', short: 'Crypt', rateClass: 'property', rightOfBurial: true },
    { id: 'property_niche', label: 'Property volume (niche)', short: 'Niche', rateClass: 'property', rightOfBurial: true },
    { id: 'other_cemetery', label: 'Other cemetery volume (designed merchandise)', short: 'Other cemetery', rateClass: 'merch' },
    { id: 'undesigned_merch', label: 'Undesigned merchandise (listed rate less 5%)', short: 'Undesigned mdse', rateClass: 'merch_less_5' },
    { id: 'unlined_vault', label: 'Unlined vault (0% commission)', short: 'Unlined vault', rateClass: 'zero' },
    { id: 'oc_pn', label: 'O&C amount — PN interment authorization fee (5%)', short: 'O&C (PN)', rateClass: 'oc_pn' },
    { id: 'oc_an', label: 'O&C amount — AN interment authorization fee (0%, no volume)', short: 'O&C (AN)', rateClass: 'oc_an', noVolume: true }
  ];

  /* Item ids used by earlier saved data. */
  var CEMETERY_ITEM_ALIASES = {
    property: 'property_ground',
    designed_merch: 'other_cemetery',
    interment_pn: 'oc_pn',
    interment_an: 'oc_an'
  };

  var CEMETERY_ITEM_BY_ID = {};
  CEMETERY_ITEM_TYPES.forEach(function (t) { CEMETERY_ITEM_BY_ID[t.id] = t; });

  function resolveItemType(id) {
    return CEMETERY_ITEM_ALIASES[id] || id;
  }

  /*
   * FINANCING OPTIONS
   *
   * The named picks from the company's Commission Auto Calc sheet. Each one
   * resolves to a Schedule A lead-source row plus whether an ACH/bank draft
   * is in place, so the property and other-cemetery percentages below match
   * that sheet's lookup tables exactly.
   */
  var FINANCING_OPTIONS = [
    { id: 'an', label: 'AN', row: 'at_need', ach: false },
    { id: 'pn_pif', label: 'PN PIF', row: 'pn_paid_full', ach: false },
    { id: 'pn_no_int', label: 'PN NO INT', row: 'pn_short_terms', ach: true },
    { id: 'pn_no_int_no_ach', label: 'PN NO INT (no ACH)', row: 'pn_short_terms', ach: false },
    { id: 'pn_36', label: 'PN ≤ 36 months', row: 'pn_25_36', ach: true },
    { id: 'pn_36_no_ach', label: 'PN ≤ 36 months (no ACH)', row: 'pn_25_36', ach: false },
    { id: 'pn_60', label: 'PN < 60 months', row: 'pn_37_60', ach: true },
    { id: 'pn_60_no_ach', label: 'PN < 60 months (no ACH)', row: 'pn_37_60', ach: false },
    { id: 'pn_under_10_dp', label: 'PN < 10% DP', row: 'pn_under_10', ach: true },
    /* Not on the company sheet's dropdown, which lists PN < 10% DP only at
     * the with-draft rate. Schedule A's under-10%-down row does have a
     * without-draft column, and it pays 0% on both property and
     * merchandise — kept here so those contracts rate honestly. */
    { id: 'pn_under_10_dp_no_ach', label: 'PN < 10% DP (no ACH)', row: 'pn_under_10', ach: false, offSheet: true }
  ];

  var FINANCING_BY_ID = {};
  FINANCING_OPTIONS.forEach(function (f) { FINANCING_BY_ID[f.id] = f; });

  /* Suggests the financing option from the deal terms, so the pick can be
   * pre-filled and cross-checked but always overridden by hand. */
  function suggestFinancingOption(input) {
    var c = classifyCemeteryLeadSource(input);
    var ach = !!input.hasAch;
    switch (c.id) {
      case 'at_need': return { id: 'an', reason: c.reason, error: c.error };
      case 'pn_paid_full': return { id: 'pn_pif', reason: c.reason, error: c.error };
      case 'pn_short_terms': return { id: ach ? 'pn_no_int' : 'pn_no_int_no_ach', reason: c.reason, error: c.error };
      case 'pn_25_36': return { id: ach ? 'pn_36' : 'pn_36_no_ach', reason: c.reason, error: c.error };
      case 'pn_37_60': return { id: ach ? 'pn_60' : 'pn_60_no_ach', reason: c.reason, error: c.error };
      case 'pn_under_10':
        return {
          id: ach ? 'pn_under_10_dp' : 'pn_under_10_dp_no_ach',
          reason: c.reason + (ach ? '' : ' Schedule A pays 12%/8% on this row only with an ACH draft — without one it pays 0%.'),
          error: c.error
        };
      default: return { id: 'pn_pif', reason: c.reason, error: c.error };
    }
  }

  /* ------------------------------------------------------------------ *
   * INSURANCE COMMISSIONS (NGL) — by age on the date of issue
   * ------------------------------------------------------------------ */

  var INSURANCE_PRODUCTS = [
    { id: 'single_pay', label: 'NGL Single Pay' },
    { id: 'three_year_autopay', label: 'NGL 3 Year with Autopay' },
    { id: 'five_year_autopay', label: 'NGL 5 Year with Autopay' },
    { id: 'efuneral', label: 'NGL/eFuneral >5 Years', discontinued: true },
    { id: 'no_autopay', label: 'NGL without Autopay', discouraged: true },
    { id: 'annuity', label: 'NGL Annuity Sales' }
  ];

  var INSURANCE_BANDS = [
    { min: 0,  max: 50,       label: '0-50',  single_pay: 8, three_year_autopay: 11, five_year_autopay: 11, efuneral: 0, no_autopay: 0, annuity: 0 },
    { min: 51, max: 70,       label: '51-70', single_pay: 9, three_year_autopay: 12, five_year_autopay: 12, efuneral: 0, no_autopay: 0, annuity: 0 },
    { min: 71, max: 75,       label: '71-75', single_pay: 7, three_year_autopay: 10, five_year_autopay: 10, efuneral: 0, no_autopay: 0, annuity: 0 },
    { min: 76, max: 80,       label: '76-80', single_pay: 4, three_year_autopay: 7,  five_year_autopay: 7,  efuneral: 0, no_autopay: 0, annuity: 0 },
    { min: 81, max: 90,       label: '81-90', single_pay: 4, three_year_autopay: 5,  five_year_autopay: 0,  efuneral: 0, no_autopay: 0, annuity: 0 },
    { min: 91, max: Infinity, label: '91+',   single_pay: 0, three_year_autopay: 0,  five_year_autopay: 0,  efuneral: 0, no_autopay: 0, annuity: 0 }
  ];

  /* ------------------------------------------------------------------ *
   * PN TRUST COMMISSIONS — by age on the contract date
   * ------------------------------------------------------------------ */

  var TRUST_BANDS = [
    { min: 0,  max: 70,       label: '0-70',  ach: 5, noAch: 3 },
    { min: 71, max: 75,       label: '71-75', ach: 7, noAch: 5 },
    { min: 76, max: 80,       label: '76-80', ach: 5, noAch: 3 },
    { min: 81, max: Infinity, label: '81+',   ach: 4, noAch: 2 }
  ];

  /* "If a PN trust turns AN within 30 days, the commission paid will be
   *  reduced (if higher) via chargeback to 4% for purchasers up to 80 years
   *  old and 2% if they are over 80." */
  var TRUST_AN_CHARGEBACK = { upTo80: 4, over80: 2 };

  /* ------------------------------------------------------------------ *
   * COMPANY GENERATED LEADS & APPOINTMENTS
   * Percentage-point adjustments, applied at most once per contract:
   *   "Contracts with more than 1 of these adjustments will only be
   *    adjusted one time"
   * ------------------------------------------------------------------ */

  var ROLES = [
    { id: 'sales_counselor', label: 'Sales Counselor', cemetery: -3.0, funeral: -1.5 },
    { id: 'marketer_driver', label: 'Marketer / Driver', cemetery: 1.0, funeral: 0.5, flatRate: true },
    { id: 'manager', label: 'Manager', cemetery: -1.0, funeral: -0.5 }
  ];

  var ROLE_BY_ID = {};
  ROLES.forEach(function (r) { ROLE_BY_ID[r.id] = r; });

  var COMPANY_LEAD_TRIGGERS = [
    'P90 Sales Initiative',
    'Appointment set by a marketer or equivalent employee',
    'Less than 5% down payment'
  ];

  /* ------------------------------------------------------------------ *
   * BONUSES
   * ------------------------------------------------------------------ */

  /* Incentive Bonus — Monthly Cemetery Pre Need Sales Volume */
  var CEMETERY_BONUS_TIERS = [
    { min: 50000, rate: 3, label: '$50,000+ = 3%' },
    { min: 30000, rate: 2, label: '$30,000 - $49,999 = 2%' },
    { min: 20000, rate: 1, label: '$20,000 - $29,999 = 1%' }
  ];

  /* Incentive Bonus — Monthly Funeral Pre Need Sales
   * (combined pre need insurance and trust sales volume) */
  var FUNERAL_BONUS_TIERS = [
    { min: 45000, rate: 2, label: '$45,000+ = 2%' },
    { min: 35000, rate: 1.5, label: '$35,000 - $44,999 = 1.5%' },
    { min: 24999, rate: 1, label: '$24,999 - $34,999 = 1%' }
  ];

  /* "*Volume towards bonus from a large sale will not exceed $25,000"
   * "*Contracts with less than a 10% down payment and no automatic payment
   *   setup will not count towards volume for bonus purposes." */
  var BONUS_VOLUME_CAP_PER_SALE = 25000;
  var BONUS_MIN_DOWN_PERCENT = 10;

  /* LAND SALE BONUSES — $100 for each of the first three processed preneed
   * contracts including a preneed right of burial at or above the location's
   * Heritage Certificate value. Sales to a relative of the sales staff member
   * are excluded. */
  var LAND_SALE_BONUS_AMOUNT = 100;
  var LAND_SALE_BONUS_MAX_PER_MONTH = 3;

  /* TRAINING PAY — $100 daily rate for up to four weeks
   * (training or commissions, whichever is greater). */
  var TRAINING_PAY_DAILY_RATE = 100;
  var TRAINING_PAY_MAX_WEEKS = 4;

  /* ------------------------------------------------------------------ *
   * SALES MONTH CALENDAR
   * ------------------------------------------------------------------ */

  var SALES_CALENDAR_2025 = [
    { year: 2025, index: 1,  label: 'January 2025',   weeks: 5, start: '2024-12-30', end: '2025-02-02', payDate: '2025-02-21' },
    { year: 2025, index: 2,  label: 'February 2025',  weeks: 4, start: '2025-02-03', end: '2025-03-02', payDate: '2025-03-21' },
    { year: 2025, index: 3,  label: 'March 2025',     weeks: 4, start: '2025-03-03', end: '2025-03-30', payDate: '2025-04-18' },
    { year: 2025, index: 4,  label: 'April 2025',     weeks: 5, start: '2025-03-31', end: '2025-05-04', payDate: '2025-05-16' },
    { year: 2025, index: 5,  label: 'May 2025',       weeks: 4, start: '2025-05-05', end: '2025-06-01', payDate: '2025-06-27' },
    { year: 2025, index: 6,  label: 'June 2025',      weeks: 4, start: '2025-06-02', end: '2025-06-29', payDate: '2025-07-25' },
    { year: 2025, index: 7,  label: 'July 2025',      weeks: 5, start: '2025-06-30', end: '2025-08-03', payDate: '2025-08-22' },
    { year: 2025, index: 8,  label: 'August 2025',    weeks: 4, start: '2025-08-04', end: '2025-09-01', payDate: '2025-09-19', note: 'Includes Labor Day' },
    { year: 2025, index: 9,  label: 'September 2025', weeks: 4, start: '2025-09-02', end: '2025-09-28', payDate: '2025-10-17' },
    { year: 2025, index: 10, label: 'October 2025',   weeks: 5, start: '2025-09-29', end: '2025-11-02', payDate: '2025-11-28' },
    { year: 2025, index: 11, label: 'November 2025',  weeks: 4, start: '2025-11-03', end: '2025-11-30', payDate: '2025-12-26' },
    { year: 2025, index: 12, label: 'December 2025',  weeks: 4, start: '2025-12-01', end: '2025-12-28', payDate: '2026-01-23' }
  ];

  var WEEK_PATTERN = [5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function addDays(iso, days) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(startIso, endIso) {
    var a = new Date(startIso + 'T00:00:00Z').getTime();
    var b = new Date(endIso + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  /*
   * Sales years other than 2025 are projected forward/backward from the
   * published 2025 calendar using its 5-4-4 week pattern. These are estimates
   * — the printed Schedule A also shifts days around holidays (August 2025
   * runs one day long to include Labor Day). Generated years are flagged
   * `estimated: true` and carry no bonus pay date.
   */
  function generateSalesYear(year) {
    if (year === 2025) { return SALES_CALENDAR_2025.map(function (p) { return Object.assign({}, p); }); }

    var start;
    if (year > 2025) {
      start = addDays('2025-12-28', 1);
      for (var y = 2026; y < year; y++) { start = addDays(start, 364); }
    } else {
      start = '2024-12-30';
      for (var y2 = 2025; y2 > year; y2--) { start = addDays(start, -364); }
    }

    var periods = [];
    var cursor = start;
    for (var i = 0; i < 12; i++) {
      var end = addDays(cursor, WEEK_PATTERN[i] * 7 - 1);
      periods.push({
        year: year,
        index: i + 1,
        label: MONTH_NAMES[i] + ' ' + year,
        weeks: WEEK_PATTERN[i],
        start: cursor,
        end: end,
        payDate: null,
        estimated: true
      });
      cursor = addDays(end, 1);
    }
    return periods;
  }

  /* Every sales period that could contain `isoDate`, nearest years first. */
  function salesPeriodForDate(isoDate, extraPeriods) {
    if (!isoDate) { return null; }
    var year = parseInt(isoDate.slice(0, 4), 10);
    var candidates = (extraPeriods || []).slice();
    [year - 1, year, year + 1].forEach(function (y) {
      candidates = candidates.concat(generateSalesYear(y));
    });
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i];
      if (isoDate >= p.start && isoDate <= p.end) { return p; }
    }
    return null;
  }

  function periodKey(period) {
    return period ? period.year + '-' + String(period.index).padStart(2, '0') : 'unassigned';
  }

  /* ------------------------------------------------------------------ *
   * Cemetery lead-source classification
   * ------------------------------------------------------------------ */

  /*
   * Picks the Schedule A lead-source row from the deal terms.
   *
   * Note that the "20%+ down / terms up to 24 months" row and the
   * "25 - 36 months" row carry identical percentages, so a contract of
   * 36 months or less with at least 10% down lands on the same rates either
   * way. The engine reports which row it used and why.
   */
  function classifyCemeteryLeadSource(input) {
    var atNeed = !!input.atNeed;
    var term = Math.max(0, Math.round(num(input.termMonths)));
    var contractAmount = num(input.contractAmount);
    var downAmount = num(input.downAmount);
    var downPercent = contractAmount > 0 ? (downAmount / contractAmount) * 100 : 0;

    if (atNeed) {
      return { id: 'at_need', downPercent: downPercent, reason: 'At-need sale.' };
    }
    if (term > MAX_TERM_MONTHS) {
      return {
        id: 'pn_37_60',
        downPercent: downPercent,
        error: 'Terms of ' + term + ' months exceed the 60-month maximum. Schedule A allows no contracts longer than 60 months.',
        reason: 'Rated at the 37 - 60 month row pending correction.'
      };
    }
    if (term <= 0) {
      return { id: 'pn_paid_full', downPercent: 100, reason: 'Paid in full — no terms.' };
    }
    if (downPercent < BONUS_MIN_DOWN_PERCENT) {
      return {
        id: 'pn_under_10',
        downPercent: downPercent,
        reason: 'Under 10% down (' + round2(downPercent) + '%) — the under-10% row governs regardless of term length.'
      };
    }
    if (term <= 24 && downPercent >= 20) {
      return { id: 'pn_short_terms', downPercent: downPercent, reason: round2(downPercent) + '% down with terms of ' + term + ' months (20%+ down, up to 24 months).' };
    }
    if (term <= 12 && downPercent >= 12) {
      return { id: 'pn_short_terms', downPercent: downPercent, reason: round2(downPercent) + '% down with terms of ' + term + ' months (12%+ down, up to 12 months).' };
    }
    if (term <= 36) {
      return {
        id: 'pn_25_36',
        downPercent: downPercent,
        reason: 'Terms of ' + term + ' months with ' + round2(downPercent) + '% down — rated at the 25 - 36 month row.'
      };
    }
    return { id: 'pn_37_60', downPercent: downPercent, reason: 'Terms of ' + term + ' months.' };
  }

  /* Base rate for one cemetery line item, before contract-level adjustments. */
  function cemeteryItemBaseRate(leadSourceId, itemType, hasAch) {
    var row = CEMETERY_BY_ID[leadSourceId];
    if (!row) { return { rate: 0, na: false }; }
    var type = CEMETERY_ITEM_BY_ID[resolveItemType(itemType)];
    if (!type) { return { rate: 0, na: false }; }

    function pick(achRate, noAchRate) {
      if (hasAch) {
        // N/A on the schedule: the ACH distinction does not apply to this row.
        return achRate == null ? { rate: noAchRate, na: true } : { rate: achRate, na: false };
      }
      return { rate: noAchRate, na: false };
    }

    switch (type.rateClass) {
      case 'property':
        return pick(row.propertyAch, row.propertyNoAch);
      case 'merch':
        return pick(row.merchAch, row.merchNoAch);
      case 'merch_less_5': {
        var base = pick(row.merchAch, row.merchNoAch);
        return { rate: Math.max(0, base.rate - UNDESIGNED_MERCH_REDUCTION), na: base.na, undesigned: true };
      }
      case 'zero':
        return { rate: UNLINED_VAULT_RATE, na: false, fixed: true };
      case 'oc_pn':
        return { rate: PN_INTERMENT_FEE_RATE, na: false, fixed: true };
      case 'oc_an':
        return { rate: AN_INTERMENT_FEE_RATE, na: false, fixed: true };
      default:
        return { rate: 0, na: false };
    }
  }

  /* The property / other-cemetery percentages behind one financing option —
   * the two lookup tables on the Commission Auto Calc sheet. */
  function financingOptionRates(optionId) {
    var opt = FINANCING_BY_ID[optionId];
    if (!opt) { return null; }
    return {
      option: opt,
      property: cemeteryItemBaseRate(opt.row, 'property_ground', opt.ach).rate,
      otherCemetery: cemeteryItemBaseRate(opt.row, 'other_cemetery', opt.ach).rate
    };
  }

  /* ------------------------------------------------------------------ *
   * Per-sale calculation
   * ------------------------------------------------------------------ */

  function roleAdjustment(roleId, track) {
    var role = ROLE_BY_ID[roleId] || ROLE_BY_ID.sales_counselor;
    return track === 'cemetery' ? role.cemetery : role.funeral;
  }

  function applyContractAdjustments(baseRate, ctx) {
    var steps = [];
    var rate = baseRate;

    // "There is a maximum 10% commission rate on large sales over $25,000."
    if (ctx.largeSale && rate > LARGE_SALE_MAX_RATE) {
      var capped = ctx.corporateRate != null ? Math.min(num(ctx.corporateRate), LARGE_SALE_MAX_RATE) : LARGE_SALE_MAX_RATE;
      steps.push({
        label: 'Large sale over $' + LARGE_SALE_THRESHOLD.toLocaleString() + ' — capped at ' + capped + '%',
        from: rate,
        to: capped
      });
      rate = capped;
    } else if (ctx.largeSale && ctx.corporateRate != null && num(ctx.corporateRate) < rate) {
      steps.push({
        label: 'Corporate-set rate for large sale',
        from: rate,
        to: num(ctx.corporateRate)
      });
      rate = num(ctx.corporateRate);
    }

    // Company generated lead / appointment — applied at most once per contract.
    if (ctx.companyLead) {
      var role = ROLE_BY_ID[ctx.roleId] || ROLE_BY_ID.sales_counselor;
      var delta = roleAdjustment(ctx.roleId, ctx.track);
      if (role.flatRate) {
        steps.push({ label: role.label + ' rate on company generated lead', from: rate, to: delta });
        rate = delta;
      } else if (delta !== 0) {
        var next = Math.max(0, rate + delta);
        steps.push({
          label: 'Company generated lead — ' + role.label + ' ' + (delta > 0 ? '+' : '') + delta.toFixed(2) + ' pts',
          from: rate,
          to: next
        });
        rate = next;
      }
    } else if ((ROLE_BY_ID[ctx.roleId] || {}).flatRate) {
      // A marketer/driver only earns on company generated business.
      steps.push({ label: 'Not a company generated lead — no marketer/driver commission', from: rate, to: 0 });
      rate = 0;
    }

    return { rate: Math.max(0, rate), steps: steps };
  }

  function calcCemeterySale(sale, settings) {
    settings = settings || {};
    var warnings = [];
    var items = (sale.items || [])
      .map(function (i) { return { type: resolveItemType(i.type), amount: i.amount, description: i.description }; })
      .filter(function (i) { return num(i.amount) !== 0; });

    var contractAmount = items.reduce(function (s, i) { return s + num(i.amount); }, 0);
    var suggestion = suggestFinancingOption({
      atNeed: sale.atNeed,
      hasAch: sale.hasAch,
      termMonths: sale.termMonths,
      contractAmount: contractAmount,
      downAmount: sale.downAmount
    });
    var classification = classifyCemeteryLeadSource({
      atNeed: sale.atNeed,
      termMonths: sale.termMonths,
      contractAmount: contractAmount,
      downAmount: sale.downAmount
    });

    /* The financing option is the authoritative pick — it is what gets keyed
     * into the company sheet. It carries its own ACH flag. */
    var financingId = sale.financingOption || suggestion.id;
    var financing = FINANCING_BY_ID[financingId] || FINANCING_BY_ID[suggestion.id];
    var leadSourceId = financing.row;
    var hasAch = financing.ach;
    var mismatch = sale.financingOption && sale.financingOption !== suggestion.id;
    if (classification.error) { warnings.push(classification.error); }
    if (mismatch) {
      warnings.push('Financing option is set to "' + financing.label + '", but the down payment and term suggest "' +
        (FINANCING_BY_ID[suggestion.id] || {}).label + '".');
    }

    var largeSale = contractAmount > LARGE_SALE_THRESHOLD;
    if (largeSale && sale.corporateRate == null) {
      warnings.push('Contract exceeds $25,000 — commission is capped at 10% until Corporate sets the actual percentage.');
    }

    var ctx = {
      largeSale: largeSale,
      corporateRate: sale.corporateRate === '' || sale.corporateRate == null ? null : num(sale.corporateRate),
      companyLead: !!sale.companyLead,
      roleId: settings.roleId || 'sales_counselor',
      track: 'cemetery'
    };

    var lines = items.map(function (item) {
      var base = cemeteryItemBaseRate(leadSourceId, item.type, hasAch);
      var adjusted;
      if (base.fixed) {
        // O&C fees and unlined vaults are fixed by the exceptions block and
        // are not subject to the contract-level rate adjustments.
        adjusted = { rate: base.rate, steps: [] };
      } else {
        adjusted = applyContractAdjustments(base.rate, ctx);
      }
      var amount = num(item.amount);
      return {
        type: item.type,
        label: (CEMETERY_ITEM_BY_ID[item.type] || {}).label || item.type,
        short: (CEMETERY_ITEM_BY_ID[item.type] || {}).short || item.type,
        description: item.description || '',
        amount: amount,
        baseRate: base.rate,
        naFallback: !!base.na,
        steps: adjusted.steps,
        rate: adjusted.rate,
        commission: pct(adjusted.rate, amount)
      };
    });

    if (hasAch && lines.some(function (l) { return l.naFallback; })) {
      warnings.push('Schedule A lists N/A in the ACH column for this lead source — the without-ACH percentage was used.');
    }

    var commission = round2(lines.reduce(function (s, l) { return s + l.commission; }, 0));
    var isPreneed = (CEMETERY_BY_ID[leadSourceId] || {}).preneed;

    /* Bonus volume: pre need only, AN O&C fees excluded outright, capped at
     * $25,000 per sale, and disqualified when the contract has under 10%
     * down and no automatic payment setup. */
    var volumeBase = items.reduce(function (s, i) {
      return (CEMETERY_ITEM_BY_ID[i.type] || {}).noVolume ? s : s + num(i.amount);
    }, 0);
    var volume = 0;
    var volumeNotes = [];
    if (!isPreneed) {
      volumeNotes.push('At-need sales do not count toward the pre need volume bonus.');
    } else if (classification.downPercent < BONUS_MIN_DOWN_PERCENT && !hasAch) {
      volumeNotes.push('Under 10% down with no automatic payment setup — excluded from bonus volume.');
    } else {
      volume = Math.min(volumeBase, BONUS_VOLUME_CAP_PER_SALE);
      if (volumeBase > BONUS_VOLUME_CAP_PER_SALE) {
        volumeNotes.push('Volume capped at $25,000 for bonus purposes.');
      }
      if (items.some(function (i) { return (CEMETERY_ITEM_BY_ID[i.type] || {}).noVolume; })) {
        volumeNotes.push('AN O&C fees excluded from volume.');
      }
    }
    if (sale.volumeOverride !== '' && sale.volumeOverride != null) {
      volume = num(sale.volumeOverride);
      volumeNotes.push('Volume manually overridden.');
    }

    /* Land sale bonus eligibility — the award itself is granted per sales
     * month, in date order, by calcPeriod(). */
    var robAmount = items.reduce(function (s, i) {
      return (CEMETERY_ITEM_BY_ID[i.type] || {}).rightOfBurial ? s + num(i.amount) : s;
    }, 0);
    var heritageValue = num(settings.heritageCertificateValue);
    var landEligible = !!isPreneed && !sale.saleToRelative && robAmount > 0 &&
      heritageValue > 0 && robAmount >= heritageValue;

    return {
      track: 'cemetery',
      lines: lines,
      contractAmount: round2(contractAmount),
      financingOptionId: financing.id,
      financingOptionLabel: financing.label,
      suggestedFinancingId: suggestion.id,
      suggestionReason: suggestion.reason,
      mismatch: !!mismatch,
      hasAch: hasAch,
      leadSourceId: leadSourceId,
      leadSourceLabel: (CEMETERY_BY_ID[leadSourceId] || {}).label || leadSourceId,
      classification: classification,
      largeSale: largeSale,
      commission: commission,
      cemeteryVolume: round2(volume),
      funeralVolume: 0,
      volumeNotes: volumeNotes,
      rightOfBurialAmount: round2(robAmount),
      landSaleEligible: landEligible,
      warnings: warnings
    };
  }

  function bandFor(bands, age) {
    var a = num(age);
    for (var i = 0; i < bands.length; i++) {
      if (a >= bands[i].min && a <= bands[i].max) { return bands[i]; }
    }
    return bands[bands.length - 1];
  }

  function calcInsuranceSale(sale, settings) {
    settings = settings || {};
    var warnings = [];
    var band = bandFor(INSURANCE_BANDS, sale.age);
    var product = sale.product || 'single_pay';
    var baseRate = band[product] != null ? band[product] : 0;
    var amount = num(sale.amount);

    if (product === 'efuneral') {
      warnings.push('eFuneral has been cancelled. No eFuneral policies should be sold.');
    }
    if (product === 'no_autopay') {
      warnings.push('Policies without auto-pay should not be sold, and pay 0% commission.');
    }
    if (baseRate === 0 && amount > 0 && product !== 'efuneral' && product !== 'no_autopay' && product !== 'annuity') {
      warnings.push('This product pays 0% at age ' + num(sale.age) + ' (' + band.label + ').');
    }

    var largeSale = amount > LARGE_SALE_THRESHOLD;
    var adjusted = applyContractAdjustments(baseRate, {
      largeSale: largeSale,
      corporateRate: sale.corporateRate === '' || sale.corporateRate == null ? null : num(sale.corporateRate),
      companyLead: !!sale.companyLead,
      roleId: settings.roleId || 'sales_counselor',
      track: 'funeral'
    });

    var volume = Math.min(amount, BONUS_VOLUME_CAP_PER_SALE);
    var volumeNotes = [];
    if (amount > BONUS_VOLUME_CAP_PER_SALE) { volumeNotes.push('Volume capped at $25,000 for bonus purposes.'); }
    if (sale.excludeFromVolume) { volume = 0; volumeNotes.push('Manually excluded from bonus volume.'); }
    if (sale.volumeOverride !== '' && sale.volumeOverride != null) {
      volume = num(sale.volumeOverride);
      volumeNotes.push('Volume manually overridden.');
    }

    return {
      track: 'funeral',
      subtype: 'insurance',
      lines: [{
        type: product,
        label: (INSURANCE_PRODUCTS.filter(function (p) { return p.id === product; })[0] || {}).label || product,
        description: 'Age ' + num(sale.age) + ' (' + band.label + ')',
        amount: amount,
        baseRate: baseRate,
        steps: adjusted.steps,
        rate: adjusted.rate,
        commission: pct(adjusted.rate, amount)
      }],
      ageBand: band.label,
      contractAmount: round2(amount),
      commission: pct(adjusted.rate, amount),
      cemeteryVolume: 0,
      funeralVolume: round2(volume),
      volumeNotes: volumeNotes,
      largeSale: largeSale,
      landSaleEligible: false,
      warnings: warnings
    };
  }

  function calcTrustSale(sale, settings) {
    settings = settings || {};
    var warnings = [];
    var band = bandFor(TRUST_BANDS, sale.age);
    var baseRate = sale.hasAch ? band.ach : band.noAch;
    var amount = num(sale.amount);
    var term = Math.max(0, Math.round(num(sale.termMonths)));

    if (term > MAX_TERM_MONTHS) {
      warnings.push('Terms of ' + term + ' months exceed the 60-month maximum for PN trust contracts.');
    }
    if (!sale.hasAch && term === 0) {
      // Single pay without a draft is not a listed column; the schedule pairs
      // "Single Pay or Terms with ACH/Bank Draft" against "Terms without".
      warnings.push('Schedule A lists single pay only under the ACH/bank draft column — the without-draft terms rate was used.');
    }

    var largeSale = amount > LARGE_SALE_THRESHOLD;
    var adjusted = applyContractAdjustments(baseRate, {
      largeSale: largeSale,
      corporateRate: sale.corporateRate === '' || sale.corporateRate == null ? null : num(sale.corporateRate),
      companyLead: !!sale.companyLead,
      roleId: settings.roleId || 'sales_counselor',
      track: 'funeral'
    });
    var rate = adjusted.rate;
    var steps = adjusted.steps.slice();

    /* Chargeback when a PN trust turns AN within 30 days. */
    if (sale.turnedAnWithin30Days) {
      var cap = num(sale.age) > 80 ? TRUST_AN_CHARGEBACK.over80 : TRUST_AN_CHARGEBACK.upTo80;
      if (rate > cap) {
        steps.push({ label: 'Turned AN within 30 days — chargeback to ' + cap + '%', from: rate, to: cap });
        rate = cap;
      } else {
        warnings.push('Turned AN within 30 days, but the earned rate (' + rate + '%) is already at or below the ' + cap + '% chargeback floor — no reduction.');
      }
    }

    var volume = Math.min(amount, BONUS_VOLUME_CAP_PER_SALE);
    var volumeNotes = [];
    if (amount > BONUS_VOLUME_CAP_PER_SALE) { volumeNotes.push('Volume capped at $25,000 for bonus purposes.'); }
    var downPercent = amount > 0 ? (num(sale.downAmount) / amount) * 100 : 0;
    if (term > 0 && downPercent < BONUS_MIN_DOWN_PERCENT && !sale.hasAch) {
      volume = 0;
      volumeNotes.push('Under 10% down with no automatic payment setup — excluded from bonus volume.');
    }
    if (sale.excludeFromVolume) { volume = 0; volumeNotes.push('Manually excluded from bonus volume.'); }
    if (sale.volumeOverride !== '' && sale.volumeOverride != null) {
      volume = num(sale.volumeOverride);
      volumeNotes.push('Volume manually overridden.');
    }

    return {
      track: 'funeral',
      subtype: 'trust',
      lines: [{
        type: 'pn_trust',
        label: sale.hasAch ? 'PN trust — single pay or terms with ACH/bank draft' : 'PN trust — terms without ACH/bank draft',
        description: 'Age ' + num(sale.age) + ' (' + band.label + ')',
        amount: amount,
        baseRate: baseRate,
        steps: steps,
        rate: rate,
        commission: pct(rate, amount)
      }],
      ageBand: band.label,
      contractAmount: round2(amount),
      commission: pct(rate, amount),
      cemeteryVolume: 0,
      funeralVolume: round2(volume),
      volumeNotes: volumeNotes,
      largeSale: largeSale,
      landSaleEligible: false,
      warnings: warnings
    };
  }

  function calcSale(sale, settings) {
    if (!sale) { return null; }
    var result;
    if (sale.category === 'insurance') { result = calcInsuranceSale(sale, settings); }
    else if (sale.category === 'trust') { result = calcTrustSale(sale, settings); }
    else { result = calcCemeterySale(sale, settings); }

    result.id = sale.id;
    result.date = sale.date;
    result.contractNumber = sale.contractNumber || '';
    result.customer = sale.customer || '';
    result.notes = sale.notes || '';
    result.category = sale.category || 'cemetery';

    /* Split — the "Split?" column on the company sheet. `totalCommission` is
     * what the contract earns; `commission` is this counselor's share, and is
     * what every downstream total uses. Bonus volume stays at the full
     * contract amount, matching how the sheet's volume columns are keyed. */
    var splitPercent = sale.splitPercent === '' || sale.splitPercent == null ? 100 : num(sale.splitPercent);
    splitPercent = Math.min(100, Math.max(0, splitPercent));
    result.splitPercent = splitPercent;
    result.totalCommission = result.commission;
    result.commission = round2(result.totalCommission * (splitPercent / 100));
    result.isSplit = splitPercent !== 100;
    if (result.isSplit && sale.splitVolume) {
      result.cemeteryVolume = round2(result.cemeteryVolume * (splitPercent / 100));
      result.funeralVolume = round2(result.funeralVolume * (splitPercent / 100));
      result.volumeNotes.push('Bonus volume split at ' + splitPercent + '%.');
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Period roll-up
   * ------------------------------------------------------------------ */

  function tierFor(tiers, volume) {
    for (var i = 0; i < tiers.length; i++) {
      if (volume >= tiers[i].min) { return tiers[i]; }
    }
    return null;
  }

  function nextTierFor(tiers, volume) {
    var next = null;
    for (var i = tiers.length - 1; i >= 0; i--) {
      if (volume < tiers[i].min) { next = tiers[i]; break; }
    }
    return next ? { tier: next, remaining: round2(next.min - volume) } : null;
  }

  /*
   * Rolls a list of sales up into one sales month: commissions, bonus
   * volumes, both incentive bonuses, and land sale bonuses.
   */
  function calcPeriod(sales, settings) {
    settings = settings || {};
    var results = (sales || []).map(function (s) { return calcSale(s, settings); });

    var commission = 0;
    var cemeteryVolume = 0;
    var funeralVolume = 0;
    results.forEach(function (r) {
      commission += r.commission;
      cemeteryVolume += r.cemeteryVolume;
      funeralVolume += r.funeralVolume;
    });
    commission = round2(commission);
    cemeteryVolume = round2(cemeteryVolume);
    funeralVolume = round2(funeralVolume);

    var cemTier = tierFor(CEMETERY_BONUS_TIERS, cemeteryVolume);
    var funTier = tierFor(FUNERAL_BONUS_TIERS, funeralVolume);
    var cemeteryBonus = cemTier ? pct(cemTier.rate, cemeteryVolume) : 0;
    var funeralBonus = funTier ? pct(funTier.rate, funeralVolume) : 0;

    /* Land sale bonus: first three qualifying preneed contracts in the month,
     * in contract-date order. */
    var landAwards = [];
    results
      .filter(function (r) { return r.landSaleEligible; })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
      .forEach(function (r) {
        if (landAwards.length < LAND_SALE_BONUS_MAX_PER_MONTH) {
          landAwards.push(r.id);
          r.landSaleAwarded = true;
        }
      });
    var landSaleBonus = landAwards.length * LAND_SALE_BONUS_AMOUNT;

    var bonusTotal = round2(cemeteryBonus + funeralBonus + landSaleBonus);
    var earned = round2(commission + bonusTotal);

    /* Training pay is "training or commissions, whichever is greater". */
    var trainingDays = Math.max(0, Math.round(num(settings.trainingDaysThisPeriod)));
    var trainingPay = trainingDays * TRAINING_PAY_DAILY_RATE;
    var trainingApplies = trainingDays > 0 && trainingPay > earned;
    var payout = round2(trainingApplies ? trainingPay : earned);

    /* Commission reserve holdback — the company sheet reports "Paid
     * Commission $ (before reserve)", so `payout` is the before-reserve
     * figure and `netPayout` applies the configured holdback. */
    var reservePercent = Math.min(100, Math.max(0, num(settings.reservePercent)));
    var reserveAmount = pct(reservePercent, payout);

    return {
      results: results,
      saleCount: results.length,
      commission: commission,
      totalCommission: round2(results.reduce(function (s, r) { return s + r.totalCommission; }, 0)),
      cemeteryVolume: cemeteryVolume,
      funeralVolume: funeralVolume,
      cemeteryTier: cemTier,
      funeralTier: funTier,
      cemeteryBonus: cemeteryBonus,
      funeralBonus: funeralBonus,
      cemeteryNext: nextTierFor(CEMETERY_BONUS_TIERS, cemeteryVolume),
      funeralNext: nextTierFor(FUNERAL_BONUS_TIERS, funeralVolume),
      landSaleAwards: landAwards.length,
      landSaleBonus: landSaleBonus,
      bonusTotal: bonusTotal,
      earned: earned,
      trainingPay: trainingPay,
      trainingApplies: trainingApplies,
      payout: payout,
      reservePercent: reservePercent,
      reserveAmount: reserveAmount,
      netPayout: round2(payout - reserveAmount),
      warnings: results.reduce(function (acc, r) {
        r.warnings.forEach(function (w) { acc.push({ id: r.id, customer: r.customer, message: w }); });
        return acc;
      }, [])
    };
  }

  return {
    SCHEDULE_VERSION: SCHEDULE_VERSION,
    CEMETERY_LEAD_SOURCES: CEMETERY_LEAD_SOURCES,
    CEMETERY_ITEM_TYPES: CEMETERY_ITEM_TYPES,
    FINANCING_OPTIONS: FINANCING_OPTIONS,
    financingOptionRates: financingOptionRates,
    suggestFinancingOption: suggestFinancingOption,
    resolveItemType: resolveItemType,
    INSURANCE_PRODUCTS: INSURANCE_PRODUCTS,
    INSURANCE_BANDS: INSURANCE_BANDS,
    TRUST_BANDS: TRUST_BANDS,
    TRUST_AN_CHARGEBACK: TRUST_AN_CHARGEBACK,
    ROLES: ROLES,
    COMPANY_LEAD_TRIGGERS: COMPANY_LEAD_TRIGGERS,
    CEMETERY_BONUS_TIERS: CEMETERY_BONUS_TIERS,
    FUNERAL_BONUS_TIERS: FUNERAL_BONUS_TIERS,
    BONUS_VOLUME_CAP_PER_SALE: BONUS_VOLUME_CAP_PER_SALE,
    BONUS_MIN_DOWN_PERCENT: BONUS_MIN_DOWN_PERCENT,
    LAND_SALE_BONUS_AMOUNT: LAND_SALE_BONUS_AMOUNT,
    LAND_SALE_BONUS_MAX_PER_MONTH: LAND_SALE_BONUS_MAX_PER_MONTH,
    TRAINING_PAY_DAILY_RATE: TRAINING_PAY_DAILY_RATE,
    TRAINING_PAY_MAX_WEEKS: TRAINING_PAY_MAX_WEEKS,
    LARGE_SALE_THRESHOLD: LARGE_SALE_THRESHOLD,
    LARGE_SALE_MAX_RATE: LARGE_SALE_MAX_RATE,
    MAX_TERM_MONTHS: MAX_TERM_MONTHS,
    UNDESIGNED_MERCH_REDUCTION: UNDESIGNED_MERCH_REDUCTION,
    SALES_CALENDAR_2025: SALES_CALENDAR_2025,
    generateSalesYear: generateSalesYear,
    salesPeriodForDate: salesPeriodForDate,
    periodKey: periodKey,
    addDays: addDays,
    daysBetween: daysBetween,
    classifyCemeteryLeadSource: classifyCemeteryLeadSource,
    cemeteryItemBaseRate: cemeteryItemBaseRate,
    calcSale: calcSale,
    calcPeriod: calcPeriod,
    round2: round2,
    num: num
  };
});
