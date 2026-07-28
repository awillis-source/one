'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../assets/rules.js');

const settings = { roleId: 'sales_counselor', heritageCertificateValue: 3000 };

function cemetery(overrides) {
  return Object.assign({
    id: 's1',
    date: '2025-03-10',
    category: 'cemetery',
    atNeed: false,
    hasAch: false,
    termMonths: 0,
    downAmount: 0,
    items: []
  }, overrides);
}

/* ------------------------------------------------------------------ *
 * Cemetery rate table
 * ------------------------------------------------------------------ */

test('cemetery: at need pays 10% on property and merchandise, no ACH column', () => {
  assert.equal(R.cemeteryItemBaseRate('at_need', 'property_ground', false).rate, 10);
  assert.equal(R.cemeteryItemBaseRate('at_need', 'other_cemetery', false).rate, 10);
  // N/A in the ACH column falls back to the without-ACH figure.
  const withAch = R.cemeteryItemBaseRate('at_need', 'property_ground', true);
  assert.equal(withAch.rate, 10);
  assert.equal(withAch.na, true);
});

test('cemetery: paid in full pays 20% property / 16% designed merchandise', () => {
  assert.equal(R.cemeteryItemBaseRate('pn_paid_full', 'property_ground', false).rate, 20);
  assert.equal(R.cemeteryItemBaseRate('pn_paid_full', 'other_cemetery', false).rate, 16);
});

test('cemetery: short-term and 25-36 rows both pay 18/16/14/12', () => {
  for (const row of ['pn_short_terms', 'pn_25_36']) {
    assert.equal(R.cemeteryItemBaseRate(row, 'property_ground', true).rate, 18);
    assert.equal(R.cemeteryItemBaseRate(row, 'property_ground', false).rate, 16);
    assert.equal(R.cemeteryItemBaseRate(row, 'other_cemetery', true).rate, 14);
    assert.equal(R.cemeteryItemBaseRate(row, 'other_cemetery', false).rate, 12);
  }
});

test('cemetery: 37-60 month row pays 16/14/12/10', () => {
  assert.equal(R.cemeteryItemBaseRate('pn_37_60', 'property_ground', true).rate, 16);
  assert.equal(R.cemeteryItemBaseRate('pn_37_60', 'property_ground', false).rate, 14);
  assert.equal(R.cemeteryItemBaseRate('pn_37_60', 'other_cemetery', true).rate, 12);
  assert.equal(R.cemeteryItemBaseRate('pn_37_60', 'other_cemetery', false).rate, 10);
});

test('cemetery: under 10% down pays 12/0/8/0', () => {
  assert.equal(R.cemeteryItemBaseRate('pn_under_10', 'property_ground', true).rate, 12);
  assert.equal(R.cemeteryItemBaseRate('pn_under_10', 'property_ground', false).rate, 0);
  assert.equal(R.cemeteryItemBaseRate('pn_under_10', 'other_cemetery', true).rate, 8);
  assert.equal(R.cemeteryItemBaseRate('pn_under_10', 'other_cemetery', false).rate, 0);
});

/* ------------------------------------------------------------------ *
 * Cemetery exceptions
 * ------------------------------------------------------------------ */

test('exception: undesigned merchandise is the listed rate less 5%, floored at 0', () => {
  // 14% designed with ACH -> 9% undesigned
  assert.equal(R.cemeteryItemBaseRate('pn_short_terms', 'undesigned_merch', true).rate, 9);
  // 0% designed without ACH -> stays 0, never negative
  assert.equal(R.cemeteryItemBaseRate('pn_under_10', 'undesigned_merch', false).rate, 0);
});

test('exception: unlined vaults pay 0%', () => {
  assert.equal(R.cemeteryItemBaseRate('pn_paid_full', 'unlined_vault', true).rate, 0);
});

test('exception: PN interment fees pay 5%, AN interment fees pay 0% and no volume', () => {
  assert.equal(R.cemeteryItemBaseRate('pn_37_60', 'oc_pn', false).rate, 5);
  assert.equal(R.cemeteryItemBaseRate('at_need', 'oc_an', false).rate, 0);

  const r = R.calcSale(cemetery({
    items: [
      { type: 'property_ground', amount: 5000 },
      { type: 'oc_an', amount: 1000 }
    ]
  }), settings);
  // Paid in full: 20% of 5,000 = 1,000. AN fee contributes nothing.
  assert.equal(r.commission, 1000);
  assert.equal(r.cemeteryVolume, 5000);
});

test('exception: interment fees are not reduced by the company lead take-away', () => {
  const r = R.calcSale(cemetery({
    companyLead: true,
    items: [{ type: 'oc_pn', amount: 1000 }]
  }), settings);
  assert.equal(r.lines[0].rate, 5);
  assert.equal(r.commission, 50);
});

test('exception: large sales over $25,000 are capped at a 10% rate', () => {
  const r = R.calcSale(cemetery({
    items: [{ type: 'property_ground', amount: 30000 }]
  }), settings);
  // Paid in full would be 20%, capped to 10%.
  assert.equal(r.lines[0].baseRate, 20);
  assert.equal(r.lines[0].rate, 10);
  assert.equal(r.commission, 3000);
  assert.ok(r.warnings.some(w => /Corporate/.test(w)));
});

test('exception: a corporate-set rate below the cap is honoured', () => {
  const r = R.calcSale(cemetery({
    corporateRate: 6,
    items: [{ type: 'property_ground', amount: 30000 }]
  }), settings);
  assert.equal(r.lines[0].rate, 6);
  assert.equal(r.commission, 1800);
});

test('exception: a sale of exactly $25,000 is not a large sale', () => {
  const r = R.calcSale(cemetery({
    items: [{ type: 'property_ground', amount: 25000 }]
  }), settings);
  assert.equal(r.largeSale, false);
  assert.equal(r.lines[0].rate, 20);
});

/* ------------------------------------------------------------------ *
 * Lead source classification
 * ------------------------------------------------------------------ */

test('classification: no terms is paid in full', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 0, contractAmount: 5000, downAmount: 5000 });
  assert.equal(c.id, 'pn_paid_full');
});

test('classification: 20% down over 24 months lands on the short-term row', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 24, contractAmount: 10000, downAmount: 2000 });
  assert.equal(c.id, 'pn_short_terms');
});

test('classification: 12% down over 12 months lands on the short-term row', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 12, contractAmount: 10000, downAmount: 1200 });
  assert.equal(c.id, 'pn_short_terms');
});

test('classification: 12% down over 24 months is rated at the 25-36 row (identical percentages)', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 24, contractAmount: 10000, downAmount: 1200 });
  assert.equal(c.id, 'pn_25_36');
  assert.equal(R.cemeteryItemBaseRate('pn_25_36', 'property_ground', true).rate,
    R.cemeteryItemBaseRate('pn_short_terms', 'property_ground', true).rate);
});

test('classification: 48 months lands on the 37-60 row', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 48, contractAmount: 10000, downAmount: 3000 });
  assert.equal(c.id, 'pn_37_60');
});

test('classification: under 10% down wins regardless of term length', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 12, contractAmount: 10000, downAmount: 500 });
  assert.equal(c.id, 'pn_under_10');
});

test('classification: terms beyond 60 months are flagged as not allowed', () => {
  const c = R.classifyCemeteryLeadSource({ termMonths: 72, contractAmount: 10000, downAmount: 3000 });
  assert.match(c.error, /60-month maximum/);
});

/* ------------------------------------------------------------------ *
 * Financing options — must match the company Commission Auto Calc sheet
 * ------------------------------------------------------------------ */

test('financing options: property and other-cemetery lookups match the company sheet', () => {
  const expected = {
    an: [10, 10],
    pn_pif: [20, 16],
    pn_no_int: [18, 14],
    pn_no_int_no_ach: [16, 12],
    pn_36: [18, 14],
    pn_36_no_ach: [16, 12],
    pn_60: [16, 12],
    pn_60_no_ach: [14, 10],
    pn_under_10_dp: [12, 8]
  };
  for (const [id, [property, other]] of Object.entries(expected)) {
    const rates = R.financingOptionRates(id);
    assert.equal(rates.property, property, `${id} property %`);
    assert.equal(rates.otherCemetery, other, `${id} other cemetery %`);
  }
});

test('financing options: the off-sheet no-ACH under-10% row pays 0% both ways', () => {
  const rates = R.financingOptionRates('pn_under_10_dp_no_ach');
  assert.equal(rates.property, 0);
  assert.equal(rates.otherCemetery, 0);
});

test('financing options: terms and down payment suggest the right pick', () => {
  const cases = [
    [{ atNeed: true }, 'an'],
    [{ termMonths: 0, contractAmount: 5000, downAmount: 5000 }, 'pn_pif'],
    [{ termMonths: 12, contractAmount: 10000, downAmount: 2500, hasAch: true }, 'pn_no_int'],
    [{ termMonths: 12, contractAmount: 10000, downAmount: 2500, hasAch: false }, 'pn_no_int_no_ach'],
    [{ termMonths: 30, contractAmount: 10000, downAmount: 1500, hasAch: true }, 'pn_36'],
    [{ termMonths: 30, contractAmount: 10000, downAmount: 1500, hasAch: false }, 'pn_36_no_ach'],
    [{ termMonths: 48, contractAmount: 10000, downAmount: 1500, hasAch: true }, 'pn_60'],
    [{ termMonths: 48, contractAmount: 10000, downAmount: 1500, hasAch: false }, 'pn_60_no_ach'],
    [{ termMonths: 48, contractAmount: 10000, downAmount: 500, hasAch: true }, 'pn_under_10_dp'],
    [{ termMonths: 48, contractAmount: 10000, downAmount: 500, hasAch: false }, 'pn_under_10_dp_no_ach']
  ];
  for (const [input, expected] of cases) {
    assert.equal(R.suggestFinancingOption(input).id, expected, JSON.stringify(input));
  }
});

test('financing options: an explicit pick overrides the suggestion and is flagged', () => {
  const r = R.calcSale(cemetery({
    termMonths: 48, downAmount: 1500, hasAch: true,
    financingOption: 'pn_pif',
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.financingOptionId, 'pn_pif');
  assert.equal(r.lines[0].rate, 20);
  assert.equal(r.mismatch, true);
  assert.ok(r.warnings.some(w => /suggest/.test(w)));
});

test('financing options: ground, crypt and niche all price off the property column', () => {
  const r = R.calcSale(cemetery({
    financingOption: 'pn_60',
    items: [
      { type: 'property_ground', amount: 1000 },
      { type: 'property_crypt', amount: 1000 },
      { type: 'property_niche', amount: 1000 },
      { type: 'other_cemetery', amount: 1000 }
    ]
  }), settings);
  assert.deepEqual(r.lines.map(l => l.rate), [16, 16, 16, 12]);
  assert.equal(r.commission, 160 + 160 + 160 + 120);
});

test('financing options: legacy item ids still resolve', () => {
  const r = R.calcSale(cemetery({
    financingOption: 'pn_pif',
    items: [{ type: 'property', amount: 1000 }, { type: 'designed_merch', amount: 1000 }]
  }), settings);
  assert.deepEqual(r.lines.map(l => l.rate), [20, 16]);
});

/* ------------------------------------------------------------------ *
 * Splits and reserve
 * ------------------------------------------------------------------ */

test('split: a 50% split halves the commission but not the bonus volume', () => {
  const r = R.calcSale(cemetery({
    splitPercent: 50,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.totalCommission, 2000);
  assert.equal(r.commission, 1000);
  assert.equal(r.cemeteryVolume, 10000);
  assert.equal(r.isSplit, true);
});

test('split: volume can be split too when the contract calls for it', () => {
  const r = R.calcSale(cemetery({
    splitPercent: 50, splitVolume: true,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.cemeteryVolume, 5000);
});

test('split: an absent or 100% split leaves the commission whole', () => {
  for (const splitPercent of [undefined, '', 100]) {
    const r = R.calcSale(cemetery({ splitPercent, items: [{ type: 'property_ground', amount: 10000 }] }), settings);
    assert.equal(r.commission, 2000);
    assert.equal(r.isSplit, false);
  }
});

test('reserve: the payout is reported before and after the holdback', () => {
  const period = R.calcPeriod(
    [cemetery({ items: [{ type: 'property_ground', amount: 10000 }] })],
    Object.assign({}, settings, { reservePercent: 10 })
  );
  // $2,000 commission + the $100 land sale bonus this contract earns.
  assert.equal(period.payout, 2100);
  assert.equal(period.reserveAmount, 210);
  assert.equal(period.netPayout, 1890);
});

/* ------------------------------------------------------------------ *
 * Company generated leads
 * ------------------------------------------------------------------ */

test('company lead: sales counselor gives up 3 points on cemetery', () => {
  const r = R.calcSale(cemetery({
    hasAch: true,
    termMonths: 36,
    downAmount: 1500,
    companyLead: true,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.lines[0].baseRate, 18);
  assert.equal(r.lines[0].rate, 15);
  assert.equal(r.commission, 1500);
});

test('company lead: the take-away never drives a rate below zero', () => {
  const r = R.calcSale(cemetery({
    hasAch: false,
    termMonths: 24,
    downAmount: 100,   // under 10% down -> 0% without ACH
    companyLead: true,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.lines[0].rate, 0);
  assert.equal(r.commission, 0);
});

test('company lead: sales counselor gives up 1.5 points on funeral business', () => {
  const r = R.calcSale({
    id: 'i1', date: '2025-03-10', category: 'insurance',
    age: 60, product: 'three_year_autopay', amount: 10000, companyLead: true
  }, settings);
  assert.equal(r.lines[0].baseRate, 12);
  assert.equal(r.lines[0].rate, 10.5);
  assert.equal(r.commission, 1050);
});

test('company lead: the adjustment is applied only once per contract', () => {
  const r = R.calcSale(cemetery({
    hasAch: true,
    termMonths: 36,
    downAmount: 1500,
    companyLead: true,
    companyLeadTriggers: ['P90 Sales Initiative', 'Appointment set by a marketer or equivalent employee'],
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.lines[0].rate, 15); // 18 - 3, not 18 - 6
});

test('company lead: a marketer/driver earns 1% on cemetery and nothing otherwise', () => {
  const marketer = { roleId: 'marketer_driver' };
  const withLead = R.calcSale(cemetery({
    companyLead: true,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), marketer);
  assert.equal(withLead.commission, 100);

  const withoutLead = R.calcSale(cemetery({
    items: [{ type: 'property_ground', amount: 10000 }]
  }), marketer);
  assert.equal(withoutLead.commission, 0);
});

/* ------------------------------------------------------------------ *
 * Insurance
 * ------------------------------------------------------------------ */

test('insurance: rate table matches Schedule A across every band', () => {
  const expected = {
    '0-50':  { single_pay: 8, three_year_autopay: 11, five_year_autopay: 11 },
    '51-70': { single_pay: 9, three_year_autopay: 12, five_year_autopay: 12 },
    '71-75': { single_pay: 7, three_year_autopay: 10, five_year_autopay: 10 },
    '76-80': { single_pay: 4, three_year_autopay: 7,  five_year_autopay: 7 },
    '81-90': { single_pay: 4, three_year_autopay: 5,  five_year_autopay: 0 },
    '91+':   { single_pay: 0, three_year_autopay: 0,  five_year_autopay: 0 }
  };
  for (const band of R.INSURANCE_BANDS) {
    for (const [product, rate] of Object.entries(expected[band.label])) {
      assert.equal(band[product], rate, `${band.label} / ${product}`);
    }
    assert.equal(band.efuneral, 0);
    assert.equal(band.no_autopay, 0);
    assert.equal(band.annuity, 0);
  }
});

test('insurance: band boundaries resolve to the right row', () => {
  const at50 = R.calcSale({ id: 'a', category: 'insurance', age: 50, product: 'single_pay', amount: 1000 }, settings);
  const at51 = R.calcSale({ id: 'b', category: 'insurance', age: 51, product: 'single_pay', amount: 1000 }, settings);
  const at91 = R.calcSale({ id: 'c', category: 'insurance', age: 91, product: 'three_year_autopay', amount: 1000 }, settings);
  assert.equal(at50.commission, 80);
  assert.equal(at51.commission, 90);
  assert.equal(at91.commission, 0);
});

test('insurance: eFuneral and no-autopay pay nothing and raise a warning', () => {
  const ef = R.calcSale({ id: 'a', category: 'insurance', age: 45, product: 'efuneral', amount: 10000 }, settings);
  assert.equal(ef.commission, 0);
  assert.ok(ef.warnings.some(w => /cancelled/.test(w)));

  const na = R.calcSale({ id: 'b', category: 'insurance', age: 45, product: 'no_autopay', amount: 10000 }, settings);
  assert.equal(na.commission, 0);
  assert.ok(na.warnings.some(w => /auto-pay/.test(w)));
});

test('insurance: an 81-90 five-year-with-autopay policy pays 0%', () => {
  const r = R.calcSale({ id: 'a', category: 'insurance', age: 85, product: 'five_year_autopay', amount: 10000 }, settings);
  assert.equal(r.commission, 0);
});

/* ------------------------------------------------------------------ *
 * PN trust
 * ------------------------------------------------------------------ */

test('trust: rate table matches Schedule A', () => {
  const expected = { '0-70': [5, 3], '71-75': [7, 5], '76-80': [5, 3], '81+': [4, 2] };
  for (const band of R.TRUST_BANDS) {
    assert.equal(band.ach, expected[band.label][0], band.label);
    assert.equal(band.noAch, expected[band.label][1], band.label);
  }
});

test('trust: 73-year-old with a draft pays 7%', () => {
  const r = R.calcSale({ id: 't', category: 'trust', age: 73, hasAch: true, amount: 10000, termMonths: 24, downAmount: 2000 }, settings);
  assert.equal(r.commission, 700);
});

test('trust: turning AN within 30 days charges back to 4% under 80', () => {
  const r = R.calcSale({ id: 't', category: 'trust', age: 73, hasAch: true, amount: 10000, turnedAnWithin30Days: true }, settings);
  assert.equal(r.lines[0].baseRate, 7);
  assert.equal(r.lines[0].rate, 4);
  assert.equal(r.commission, 400);
});

test('trust: turning AN within 30 days charges back to 2% over 80', () => {
  const r = R.calcSale({ id: 't', category: 'trust', age: 84, hasAch: true, amount: 10000, turnedAnWithin30Days: true }, settings);
  assert.equal(r.lines[0].baseRate, 4);
  assert.equal(r.lines[0].rate, 2);
});

test('trust: the chargeback only reduces, never raises, the rate', () => {
  const r = R.calcSale({ id: 't', category: 'trust', age: 84, hasAch: false, amount: 10000, turnedAnWithin30Days: true }, settings);
  assert.equal(r.lines[0].baseRate, 2);
  assert.equal(r.lines[0].rate, 2);
  assert.ok(r.warnings.some(w => /no reduction/.test(w)));
});

test('trust: terms beyond 60 months are flagged', () => {
  const r = R.calcSale({ id: 't', category: 'trust', age: 60, hasAch: true, amount: 5000, termMonths: 72 }, settings);
  assert.ok(r.warnings.some(w => /60-month maximum/.test(w)));
});

/* ------------------------------------------------------------------ *
 * Bonus volume
 * ------------------------------------------------------------------ */

test('volume: at-need sales contribute nothing to pre need volume', () => {
  const r = R.calcSale(cemetery({ atNeed: true, items: [{ type: 'property_ground', amount: 8000 }] }), settings);
  assert.equal(r.cemeteryVolume, 0);
  assert.equal(r.commission, 800);
});

test('volume: a large sale contributes at most $25,000', () => {
  const r = R.calcSale(cemetery({ items: [{ type: 'property_ground', amount: 40000 }] }), settings);
  assert.equal(r.cemeteryVolume, 25000);
});

test('volume: under 10% down with no automatic payment is excluded', () => {
  const r = R.calcSale(cemetery({
    hasAch: false, termMonths: 36, downAmount: 200,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.cemeteryVolume, 0);
  assert.ok(r.volumeNotes.some(n => /excluded from bonus volume/.test(n)));
});

test('volume: under 10% down still counts when an ACH draft is set up', () => {
  const r = R.calcSale(cemetery({
    hasAch: true, termMonths: 36, downAmount: 200,
    items: [{ type: 'property_ground', amount: 10000 }]
  }), settings);
  assert.equal(r.cemeteryVolume, 10000);
});

/* ------------------------------------------------------------------ *
 * Bonuses
 * ------------------------------------------------------------------ */

test('bonus: cemetery volume tiers pay 1% / 2% / 3%', () => {
  const cases = [
    [19999, 0, 0],
    [20000, 1, 200],
    [29999, 1, 299.99],
    [30000, 2, 600],
    [49999, 2, 999.98],
    [50000, 3, 1500]
  ];
  for (const [volume, rate, bonus] of cases) {
    const period = R.calcPeriod([cemetery({
      id: 'v' + volume,
      volumeOverride: volume,
      items: [{ type: 'property_ground', amount: 100 }]
    })], settings);
    assert.equal(period.cemeteryVolume, volume, `volume ${volume}`);
    assert.equal(period.cemeteryTier ? period.cemeteryTier.rate : 0, rate, `rate at ${volume}`);
    assert.equal(period.cemeteryBonus, bonus, `bonus at ${volume}`);
  }
});

test('bonus: funeral volume tiers pay 1% / 1.5% / 2%', () => {
  const cases = [
    [24998, 0, 0],
    [24999, 1, 249.99],
    [34999, 1, 349.99],
    [35000, 1.5, 525],
    [44999, 1.5, 674.99],
    [45000, 2, 900]
  ];
  for (const [volume, rate, bonus] of cases) {
    const period = R.calcPeriod([{
      id: 'f' + volume, date: '2025-03-10', category: 'trust',
      age: 60, hasAch: true, amount: 1000, volumeOverride: volume
    }], settings);
    assert.equal(period.funeralVolume, volume, `volume ${volume}`);
    assert.equal(period.funeralTier ? period.funeralTier.rate : 0, rate, `rate at ${volume}`);
    assert.equal(period.funeralBonus, bonus, `bonus at ${volume}`);
  }
});

test('bonus: funeral volume combines insurance and trust', () => {
  const period = R.calcPeriod([
    { id: 'a', date: '2025-03-05', category: 'insurance', age: 60, product: 'single_pay', amount: 20000 },
    { id: 'b', date: '2025-03-06', category: 'trust', age: 60, hasAch: true, amount: 20000 }
  ], settings);
  assert.equal(period.funeralVolume, 40000);
  assert.equal(period.funeralTier.rate, 1.5);
  assert.equal(period.funeralBonus, 600);
});

test('bonus: next-tier tracking reports the gap to the next threshold', () => {
  const period = R.calcPeriod([cemetery({ volumeOverride: 26000, items: [{ type: 'property_ground', amount: 100 }] })], settings);
  assert.equal(period.cemeteryNext.tier.min, 30000);
  assert.equal(period.cemeteryNext.remaining, 4000);
});

/* ------------------------------------------------------------------ *
 * Land sale bonus
 * ------------------------------------------------------------------ */

test('land sale bonus: pays $100 for at most the first three qualifying contracts', () => {
  const sales = ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06'].map((date, i) =>
    cemetery({ id: 'l' + i, date, items: [{ type: 'property_ground', amount: 4000 }] }));
  const period = R.calcPeriod(sales, settings);
  assert.equal(period.landSaleAwards, 3);
  assert.equal(period.landSaleBonus, 300);
  assert.deepEqual(period.results.map(r => !!r.landSaleAwarded), [true, true, true, false]);
});

test('land sale bonus: right of burial below the Heritage Certificate value does not qualify', () => {
  const period = R.calcPeriod([cemetery({ items: [{ type: 'property_ground', amount: 2000 }] })], settings);
  assert.equal(period.landSaleAwards, 0);
});

test('land sale bonus: sales to a relative are excluded', () => {
  const period = R.calcPeriod([cemetery({ saleToRelative: true, items: [{ type: 'property_ground', amount: 9000 }] })], settings);
  assert.equal(period.landSaleAwards, 0);
});

test('land sale bonus: at-need sales do not qualify', () => {
  const period = R.calcPeriod([cemetery({ atNeed: true, items: [{ type: 'property_ground', amount: 9000 }] })], settings);
  assert.equal(period.landSaleAwards, 0);
});

test('land sale bonus: merchandise alone is not a right of burial', () => {
  const period = R.calcPeriod([cemetery({ items: [{ type: 'other_cemetery', amount: 9000 }] })], settings);
  assert.equal(period.landSaleAwards, 0);
});

/* ------------------------------------------------------------------ *
 * Training pay
 * ------------------------------------------------------------------ */

test('training pay: pays the greater of $100/day or earned commissions', () => {
  const lowMonth = R.calcPeriod([cemetery({ items: [{ type: 'property_ground', amount: 1000 }] })],
    Object.assign({}, settings, { trainingDaysThisPeriod: 20 }));
  assert.equal(lowMonth.earned, 200);
  assert.equal(lowMonth.trainingPay, 2000);
  assert.equal(lowMonth.payout, 2000);

  const goodMonth = R.calcPeriod([cemetery({ items: [{ type: 'property_ground', amount: 40000 }] })],
    Object.assign({}, settings, { trainingDaysThisPeriod: 20 }));
  assert.ok(goodMonth.earned > 2000);
  assert.equal(goodMonth.payout, goodMonth.earned);
});

/* ------------------------------------------------------------------ *
 * Sales month calendar
 * ------------------------------------------------------------------ */

test('calendar: the 2025 sales months match the printed schedule', () => {
  const expected = [
    ['January 2025', 5, '2024-12-30', '2025-02-02', '2025-02-21'],
    ['February 2025', 4, '2025-02-03', '2025-03-02', '2025-03-21'],
    ['March 2025', 4, '2025-03-03', '2025-03-30', '2025-04-18'],
    ['April 2025', 5, '2025-03-31', '2025-05-04', '2025-05-16'],
    ['May 2025', 4, '2025-05-05', '2025-06-01', '2025-06-27'],
    ['June 2025', 4, '2025-06-02', '2025-06-29', '2025-07-25'],
    ['July 2025', 5, '2025-06-30', '2025-08-03', '2025-08-22'],
    ['August 2025', 4, '2025-08-04', '2025-09-01', '2025-09-19'],
    ['September 2025', 4, '2025-09-02', '2025-09-28', '2025-10-17'],
    ['October 2025', 5, '2025-09-29', '2025-11-02', '2025-11-28'],
    ['November 2025', 4, '2025-11-03', '2025-11-30', '2025-12-26'],
    ['December 2025', 4, '2025-12-01', '2025-12-28', '2026-01-23']
  ];
  assert.equal(R.SALES_CALENDAR_2025.length, 12);
  R.SALES_CALENDAR_2025.forEach((p, i) => {
    assert.deepEqual([p.label, p.weeks, p.start, p.end, p.payDate], expected[i]);
  });
});

test('calendar: 2025 periods are contiguous with no gaps or overlaps', () => {
  for (let i = 1; i < R.SALES_CALENDAR_2025.length; i++) {
    const prev = R.SALES_CALENDAR_2025[i - 1];
    const cur = R.SALES_CALENDAR_2025[i];
    assert.equal(R.addDays(prev.end, 1), cur.start, `${prev.label} -> ${cur.label}`);
  }
});

test('calendar: a date resolves to the sales month that contains it', () => {
  // 12/30/2024 is inside the January 2025 sales month, not December 2024.
  assert.equal(R.salesPeriodForDate('2024-12-30').label, 'January 2025');
  assert.equal(R.salesPeriodForDate('2025-02-02').label, 'January 2025');
  assert.equal(R.salesPeriodForDate('2025-02-03').label, 'February 2025');
  assert.equal(R.salesPeriodForDate('2025-09-01').label, 'August 2025');
  assert.equal(R.salesPeriodForDate('2025-12-28').label, 'December 2025');
});

test('calendar: generated years continue the 5-4-4 pattern and are flagged as estimates', () => {
  const y2026 = R.generateSalesYear(2026);
  assert.equal(y2026.length, 12);
  assert.equal(y2026[0].start, '2025-12-29');
  assert.equal(y2026[0].estimated, true);
  assert.equal(y2026[0].payDate, null);
  assert.equal(R.daysBetween(y2026[0].start, y2026[11].end), 363); // 52 weeks
});

test('calendar: generated years abut the published 2025 calendar on both sides', () => {
  const y2024 = R.generateSalesYear(2024);
  const y2026 = R.generateSalesYear(2026);
  assert.equal(R.addDays(y2024[11].end, 1), R.SALES_CALENDAR_2025[0].start);
  assert.equal(R.addDays(R.SALES_CALENDAR_2025[11].end, 1), y2026[0].start);
});

/* ------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------ */

test('end to end: a mixed month rolls up commissions, bonuses and payout', () => {
  const sales = [
    // 36-month contract, ACH, 20% down: property 18%, designed merch 14%,
    // undesigned merch 9%, unlined vault 0%.
    cemetery({
      id: 'c1', date: '2025-03-04', hasAch: true, termMonths: 36, downAmount: 4000,
      items: [
        { type: 'property_ground', amount: 12000 },
        { type: 'other_cemetery', amount: 6000 },
        { type: 'undesigned_merch', amount: 1500 },
        { type: 'unlined_vault', amount: 500 }
      ]
    }),
    // Paid in full, property only: 20%.
    cemetery({ id: 'c2', date: '2025-03-11', items: [{ type: 'property_ground', amount: 9000 }] }),
    // Insurance, age 62, 3-year autopay: 12%.
    { id: 'i1', date: '2025-03-12', category: 'insurance', age: 62, product: 'three_year_autopay', amount: 15000 },
    // Trust, age 78, ACH: 5%.
    { id: 't1', date: '2025-03-18', category: 'trust', age: 78, hasAch: true, amount: 12000, termMonths: 24, downAmount: 3000 }
  ];

  const period = R.calcPeriod(sales, settings);

  // Commissions
  const c1 = period.results[0];
  assert.equal(c1.commission, 2160 + 840 + 135 + 0);
  assert.equal(period.results[1].commission, 1800);
  assert.equal(period.results[2].commission, 1800);
  assert.equal(period.results[3].commission, 600);
  assert.equal(period.commission, 3135 + 1800 + 1800 + 600);

  // Volume: cemetery 20,000 + 9,000; funeral 15,000 + 12,000
  assert.equal(period.cemeteryVolume, 29000);
  assert.equal(period.funeralVolume, 27000);

  // Bonuses: cemetery 1% of 29,000; funeral 1% of 27,000
  assert.equal(period.cemeteryBonus, 290);
  assert.equal(period.funeralBonus, 270);

  // Land sale bonus: two qualifying preneed right-of-burial contracts
  assert.equal(period.landSaleAwards, 2);
  assert.equal(period.landSaleBonus, 200);

  assert.equal(period.bonusTotal, 760);
  assert.equal(period.earned, 8095);
  assert.equal(period.payout, 8095);
});

test('end to end: 1,000 more in cemetery volume moves the month up a bonus tier', () => {
  const base = cemetery({ id: 'c1', date: '2025-03-04', items: [{ type: 'property_ground', amount: 25000 }] });
  const before = R.calcPeriod([base], settings);
  assert.equal(before.cemeteryBonus, 250);

  const after = R.calcPeriod([base, cemetery({ id: 'c2', date: '2025-03-05', items: [{ type: 'property_ground', amount: 5000 }] })], settings);
  assert.equal(after.cemeteryVolume, 30000);
  assert.equal(after.cemeteryBonus, 600);
});
