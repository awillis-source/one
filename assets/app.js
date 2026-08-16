/*
 * Commission Calculator — UI, state and persistence.
 *
 * Everything the user types is written to localStorage immediately (including
 * the half-finished entry form), so a refresh, a closed tab or a dead battery
 * never costs work.
 */
(function () {
  'use strict';

  var R = window.CommissionRules;
  var STORE_KEY = 'commission-calculator-v1';
  var BACKUP_KEY = 'commission-calculator-v1-backup';

  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) {
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var moneyShort = function (n) {
    return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  };
  var pctText = function (n) { return (Math.round(n * 100) / 100) + '%'; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var todayIso = function () {
    var d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  var uid = function () { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  var fmtDate = function (iso) {
    if (!iso) { return ''; }
    var p = iso.split('-');
    return p[1] + '/' + p[2] + '/' + p[0].slice(2);
  };

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  var defaultState = function () {
    return {
      version: 1,
      settings: {
        /* 'light' | 'dark' | 'system'. Light by default — following the
         * device meant the app changed colour when it moved to a machine set
         * to dark, which reads as a fault rather than a preference. */
        theme: 'light',
        roleId: 'sales_counselor',
        location: '',
        /* Heritage Certificate value for this location — the threshold a
         * preneed right of burial must reach to earn the $100 land sale
         * bonus. Change it in Settings if your location's differs. */
        heritageCertificateValue: '1195',
        reservePercent: '',
        trainingDays: {}
      },
      sales: [],
      draft: null,
      editingId: null,
      activePeriod: null,
      category: 'cemetery',
      lastBackupAt: null,
      backupSnoozedAt: null,
      installTipDismissed: false
    };
  };

  var state = defaultState();

  /*
   * Saved settings win, except that a blank saved value falls back to the
   * default. Without this, a browser that ran an earlier version — which
   * stored an empty Heritage Certificate value — would keep overriding the
   * default with that blank.
   */
  function mergeSettings(saved) {
    var merged = Object.assign(defaultState().settings, saved || {});
    Object.keys(defaultState().settings).forEach(function (k) {
      var def = defaultState().settings[k];
      if ((merged[k] === '' || merged[k] == null) && def !== '' && def != null) {
        merged[k] = def;
      }
    });
    return merged;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) { return; }
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = Object.assign(defaultState(), parsed);
        state.settings = mergeSettings(parsed.settings);
        state.sales = Array.isArray(parsed.sales) ? parsed.sales : [];
      }
    } catch (err) {
      console.error('Could not read saved data', err);
      flagStorage('Saved data could not be read. Restore a backup from Settings if your sales are missing.');
    }
  }

  var saveTimer = null;
  var lastGoodSerialization = null;

  function save(immediate) {
    $('saveState').textContent = 'Saving…';
    $('saveState').classList.add('is-saving');
    clearTimeout(saveTimer);
    var run = function () {
      try {
        var json = JSON.stringify(state);
        // Keep the previous good copy so a quota failure mid-write can't
        // leave the only copy truncated.
        if (lastGoodSerialization) { localStorage.setItem(BACKUP_KEY, lastGoodSerialization); }
        localStorage.setItem(STORE_KEY, json);
        lastGoodSerialization = json;
        var t = new Date();
        $('saveState').textContent = 'Saved ' + t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        $('saveState').classList.remove('is-saving');
      } catch (err) {
        console.error('Save failed', err);
        $('saveState').textContent = 'NOT SAVED';
        $('saveState').classList.add('is-saving');
        flagStorage('This browser refused to save (storage may be full or private browsing is on). Download a backup now from Settings.');
      }
    };
    if (immediate) { run(); } else { saveTimer = setTimeout(run, 250); }
  }

  function flagStorage(msg) {
    var el = $('storageNote');
    if (el) { el.textContent = msg; el.classList.add('is-flag'); }
  }

  /*
   * Does this browser actually keep what we write?
   *
   * A page opened inside another app's in-app browser, in private browsing, or
   * embedded as a third-party frame can throw on write — or accept the write
   * and drop it. Better to say so on the first screen than to let a month of
   * contracts vanish quietly.
   */
  var storageWorks = null;

  function checkStorage() {
    try {
      var probe = STORE_KEY + '-probe';
      localStorage.setItem(probe, 'x');
      var ok = localStorage.getItem(probe) === 'x';
      localStorage.removeItem(probe);
      storageWorks = ok;
    } catch (err) {
      storageWorks = false;
    }
    return storageWorks;
  }

  var DAY_MS = 86400000;
  var BACKUP_REMINDER_DAYS = 14;

  function daysSinceBackup() {
    if (!state.lastBackupAt) { return null; }
    return Math.floor((Date.now() - state.lastBackupAt) / DAY_MS);
  }

  /*
   * Banners carry the things that cost real money if ignored: storage that
   * isn't working, and a backup that has gone stale.
   */
  function renderBanners() {
    var box = $('banners');
    var out = '';

    if (storageWorks === false) {
      out += '<div class="banner bad"><p><b>This browser is not saving your work.</b> ' +
        'Private browsing and in-app browsers block saving. Open this page in Safari or Chrome directly, ' +
        'or add it to your home screen, then re-enter anything above.</p></div>';
    }

    var since = daysSinceBackup();
    var snoozed = state.backupSnoozedAt && (Date.now() - state.backupSnoozedAt) < 3 * DAY_MS;
    var n = state.sales.length;
    var contracts = n + ' contract' + (n === 1 ? '' : 's');
    // Nagging on the very first contract only teaches the banner to be
    // dismissed; a few entries in, the warning is worth its interruption.
    var worthBackingUp = since === null ? n >= 3 : since >= BACKUP_REMINDER_DAYS;
    if (n && !snoozed && worthBackingUp) {
      out += '<div class="banner warn"><p>' +
        (since === null
          ? '<b>No backup yet.</b> Your ' + contracts + ' exist only in this browser. ' +
            'Clearing browsing data would erase them.'
          : '<b>Last backup was ' + since + ' days ago.</b> ' + contracts + ' saved since then.') +
        '</p><span class="banner-actions"><button type="button" class="link-btn" data-banner="backup">Back up now</button>' +
        '<button type="button" class="link-btn" data-banner="snooze">Later</button></span></div>';
    }

    if (!state.installTipDismissed && !isStandalone()) {
      out += '<div class="banner"><p>Add this to your home screen and it opens like an app — ' +
        'and your saved contracts last far longer than they do in a browser tab.</p>' +
        '<span class="banner-actions"><button type="button" class="link-btn" data-banner="how">How</button>' +
        '<button type="button" class="link-btn" data-banner="gotit">Got it</button></span></div>';
    }

    box.innerHTML = out;
  }

  /* ---------------------------------------------------------------- *
   * Appearance
   * ---------------------------------------------------------------- */

  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    var choice = state.settings.theme || 'light';
    var dark = choice === 'dark' || (choice === 'system' && darkQuery && darkQuery.matches);
    if (dark) {
      document.documentElement.setAttribute('data-app-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-app-theme');
    }
  }

  function watchSystemTheme() {
    if (!darkQuery) { return; }
    var onChange = function () { if (state.settings.theme === 'system') { applyTheme(); } };
    if (darkQuery.addEventListener) { darkQuery.addEventListener('change', onChange); }
    else if (darkQuery.addListener) { darkQuery.addListener(onChange); }
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function installInstructions() {
    var ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return 'On iPhone: tap the Share button at the bottom of Safari, scroll down, and tap "Add to Home Screen".';
    }
    if (/Android/i.test(ua)) {
      return 'On Android: tap the three-dot menu in Chrome, then "Add to Home screen" (or "Install app").';
    }
    return 'On a phone, open this page in Safari or Chrome, then use the browser menu to add it to your home screen.';
  }

  /* ---------------------------------------------------------------- *
   * Periods
   * ---------------------------------------------------------------- */

  function allPeriods() {
    var years = {};
    state.sales.forEach(function (s) { if (s.date) { years[s.date.slice(0, 4)] = true; } });
    years[String(new Date().getFullYear())] = true;
    years['2025'] = true;
    var list = [];
    Object.keys(years).sort().forEach(function (y) {
      list = list.concat(R.generateSalesYear(parseInt(y, 10)));
    });
    // De-duplicate periods sharing a start date across adjacent years.
    var seen = {};
    return list.filter(function (p) {
      var k = p.start;
      if (seen[k]) { return false; }
      seen[k] = true;
      return true;
    }).sort(function (a, b) { return a.start.localeCompare(b.start); });
  }

  function periodFor(date) { return R.salesPeriodForDate(date); }

  function activePeriod() {
    var list = allPeriods();
    var match = list.filter(function (p) { return R.periodKey(p) === state.activePeriod; })[0];
    return match || periodFor(todayIso()) || list[0];
  }

  function salesInPeriod(period) {
    if (!period) { return []; }
    return state.sales
      .filter(function (s) { return s.date >= period.start && s.date <= period.end; })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)); });
  }

  function settingsFor(period) {
    return {
      roleId: state.settings.roleId,
      heritageCertificateValue: state.settings.heritageCertificateValue,
      reservePercent: state.settings.reservePercent,
      trainingDaysThisPeriod: (state.settings.trainingDays || {})[R.periodKey(period)] || 0
    };
  }

  /* ---------------------------------------------------------------- *
   * Form <-> sale object
   * ---------------------------------------------------------------- */

  var AMOUNT_FIELDS = [
    ['aGround', 'property_ground'],
    ['aCrypt', 'property_crypt'],
    ['aNiche', 'property_niche'],
    ['aOther', 'other_cemetery'],
    ['aUndesigned', 'undesigned_merch'],
    ['aVault', 'unlined_vault']
  ];

  function readForm() {
    var category = state.category;
    var sale = {
      id: state.editingId || 'preview',
      category: category,
      date: $('fDate').value || todayIso(),
      contractNumber: $('fContractNo').value.trim(),
      customer: $('fCustomer').value.trim(),
      notes: $('fNotes').value.trim(),
      companyLead: $('fCompanyLead').checked,
      splitPercent: $('fSplit').value.trim(),
      splitVolume: $('fSplitVolume').checked,
      corporateRate: $('fCorpRate').value.trim() === '' ? null : $('fCorpRate').value.trim(),
      volumeOverride: $('fVolOverride').value.trim() === '' ? null : $('fVolOverride').value.trim()
    };

    if (category === 'cemetery') {
      sale.atNeed = $('fAtNeed').checked;
      sale.hasAch = $('fHasAch').checked;
      sale.downAmount = $('fDown').value;
      sale.termMonths = $('fTerm').value;
      sale.saleToRelative = $('fRelative').checked;
      sale.financingOption = $('fFinancing').value || null;
      sale.items = AMOUNT_FIELDS.map(function (pair) {
        return { type: pair[1], amount: $(pair[0]).value };
      });
      // The O&C fee prices as PN or AN depending on the financing option.
      var opt = (R.FINANCING_OPTIONS.filter(function (f) { return f.id === sale.financingOption; })[0]) || {};
      sale.items.push({ type: opt.row === 'at_need' ? 'oc_an' : 'oc_pn', amount: $('aOc').value });
    } else if (category === 'insurance') {
      sale.age = $('iAge').value;
      sale.product = $('iProduct').value;
      sale.amount = $('iAmount').value;
    } else {
      sale.age = $('tAge').value;
      sale.amount = $('tAmount').value;
      sale.downAmount = $('tDown').value;
      sale.termMonths = $('tTerm').value;
      sale.hasAch = $('tHasAch').checked;
      sale.turnedAnWithin30Days = $('tTurnedAn').checked;
    }
    return sale;
  }

  function writeForm(sale) {
    sale = sale || {};
    state.category = sale.category || 'cemetery';
    setCategoryTabs();

    $('fDate').value = sale.date || todayIso();
    $('fContractNo').value = sale.contractNumber || '';
    $('fCustomer').value = sale.customer || '';
    $('fNotes').value = sale.notes || '';
    $('fCompanyLead').checked = !!sale.companyLead;
    $('fSplit').value = sale.splitPercent == null ? '' : sale.splitPercent;
    $('fSplitVolume').checked = !!sale.splitVolume;
    $('fCorpRate').value = sale.corporateRate == null ? '' : sale.corporateRate;
    $('fVolOverride').value = sale.volumeOverride == null ? '' : sale.volumeOverride;

    $('fAtNeed').checked = !!sale.atNeed;
    $('fHasAch').checked = !!sale.hasAch;
    $('fDown').value = sale.downAmount == null ? '' : sale.downAmount;
    $('fTerm').value = sale.termMonths == null ? '' : sale.termMonths;
    $('fRelative').checked = !!sale.saleToRelative;

    var byType = {};
    (sale.items || []).forEach(function (i) { byType[R.resolveItemType(i.type)] = i.amount; });
    AMOUNT_FIELDS.forEach(function (pair) {
      $(pair[0]).value = byType[pair[1]] == null ? '' : byType[pair[1]];
    });
    $('aOc').value = byType.oc_pn != null ? byType.oc_pn : (byType.oc_an != null ? byType.oc_an : '');

    refreshFinancingOptions(sale.financingOption);

    $('iAge').value = sale.category === 'insurance' && sale.age != null ? sale.age : '';
    $('iProduct').value = sale.product || 'single_pay';
    $('iAmount').value = sale.category === 'insurance' && sale.amount != null ? sale.amount : '';

    $('tAge').value = sale.category === 'trust' && sale.age != null ? sale.age : '';
    $('tAmount').value = sale.category === 'trust' && sale.amount != null ? sale.amount : '';
    $('tDown').value = sale.category === 'trust' && sale.downAmount != null ? sale.downAmount : '';
    $('tTerm').value = sale.category === 'trust' && sale.termMonths != null ? sale.termMonths : '';
    $('tHasAch').checked = sale.category === 'trust' && !!sale.hasAch;
    $('tTurnedAn').checked = !!sale.turnedAnWithin30Days;
  }

  /* The financing dropdown keeps a suggested pick in sync with the deal terms
   * until the user chooses one explicitly. */
  var financingTouched = false;

  function refreshFinancingOptions(selectedId) {
    var sel = $('fFinancing');
    var contractAmount = AMOUNT_FIELDS.reduce(function (s, pair) { return s + R.num($(pair[0]).value); }, 0) + R.num($('aOc').value);
    var suggestion = R.suggestFinancingOption({
      atNeed: $('fAtNeed').checked,
      hasAch: $('fHasAch').checked,
      termMonths: $('fTerm').value,
      contractAmount: contractAmount,
      downAmount: $('fDown').value
    });

    var want = selectedId != null ? selectedId : (financingTouched && sel.value ? sel.value : suggestion.id);
    if (!sel.options.length) {
      R.FINANCING_OPTIONS.forEach(function (f) {
        var o = document.createElement('option');
        o.value = f.id;
        o.textContent = f.label;
        sel.appendChild(o);
      });
    }
    Array.prototype.forEach.call(sel.options, function (o) {
      var f = R.FINANCING_OPTIONS.filter(function (x) { return x.id === o.value; })[0];
      var rates = R.financingOptionRates(o.value);
      o.textContent = f.label + '  —  ' + rates.property + '% property / ' + rates.otherCemetery + '% other';
    });
    sel.value = want;
    if (selectedId != null) { financingTouched = !!selectedId; }

    var hint = $('financingHint');
    var suggestedLabel = (R.FINANCING_OPTIONS.filter(function (f) { return f.id === suggestion.id; })[0] || {}).label;
    if (sel.value !== suggestion.id) {
      hint.textContent = 'Terms suggest "' + suggestedLabel + '". ' + suggestion.reason;
      hint.classList.add('is-flag');
    } else {
      hint.textContent = suggestion.reason;
      hint.classList.remove('is-flag');
    }
    if (suggestion.error) {
      hint.textContent = suggestion.error;
      hint.classList.add('is-flag');
    }
  }

  function setCategoryTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var on = t.dataset.category === state.category;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.cat-fields'), function (f) {
      f.hidden = f.dataset.cat !== state.category;
    });
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function renderPeriodSelect() {
    var sel = $('periodSelect');
    var period = activePeriod();
    sel.innerHTML = '';
    allPeriods().forEach(function (p) {
      var o = document.createElement('option');
      o.value = R.periodKey(p);
      o.textContent = p.label + (p.estimated ? ' (est.)' : '');
      sel.appendChild(o);
    });
    sel.value = R.periodKey(period);
  }

  function renderPreview() {
    var sale = readForm();
    var result = R.calcSale(sale, settingsFor(activePeriod()));
    var box = $('preview');

    if (!result || result.contractAmount === 0) {
      box.innerHTML = '';
      return;
    }

    var html = '<div class="preview-top"><span>' +
      (result.isSplit ? 'Your share after ' + result.splitPercent + '% split' : 'This contract pays') +
      '</span><b>' + money(result.commission) + '</b></div><div class="preview-lines">';

    result.lines.forEach(function (l) {
      if (!l.amount) { return; }
      html += '<div class="pline"><div class="pline-main"><span>' + esc(l.short || l.label) +
        '</span><span class="amt">' + money(l.commission) + '</span></div>' +
        '<div class="pline-calc">' + money(l.amount) + ' × ' + pctText(l.rate) +
        (l.rate !== l.baseRate ? '  (from ' + pctText(l.baseRate) + ')' : '') + '</div>';
      l.steps.forEach(function (s) {
        html += '<div class="pline-step">↳ ' + esc(s.label) + '</div>';
      });
      html += '</div>';
    });
    html += '</div><div class="preview-foot">';

    if (result.isSplit) {
      html += '<div>Full contract commission ' + money(result.totalCommission) + ' · your ' + result.splitPercent + '% share ' + money(result.commission) + '</div>';
    }
    if (result.track === 'cemetery') {
      html += '<div>' + esc(result.financingOptionLabel) + ' · contract ' + money(result.contractAmount) + '</div>';
    }
    var vol = result.cemeteryVolume + result.funeralVolume;
    html += '<div>Counts ' + money(vol) + ' toward the ' + (result.track === 'cemetery' ? 'cemetery' : 'funeral') + ' bonus volume</div>';
    result.volumeNotes.forEach(function (n) { html += '<div>' + esc(n) + '</div>'; });
    if (result.landSaleEligible) { html += '<div>Qualifies for the $100 land sale bonus, if within the first three this month</div>'; }
    result.warnings.forEach(function (w) { html += '<div class="warn">⚠ ' + esc(w) + '</div>'; });
    html += '</div>';

    box.innerHTML = html;
  }

  function meterPosition(volume, stops) {
    // Piecewise-linear so each tier mark sits at a fixed position on the bar.
    for (var i = 0; i < stops.length - 1; i++) {
      if (volume < stops[i + 1].value) {
        var span = stops[i + 1].value - stops[i].value;
        var frac = span > 0 ? (volume - stops[i].value) / span : 0;
        return stops[i].pos + frac * (stops[i + 1].pos - stops[i].pos);
      }
    }
    return 100;
  }

  function renderDashboard() {
    var period = activePeriod();
    var sales = salesInPeriod(period);
    var p = R.calcPeriod(sales, settingsFor(period));

    $('periodRange').textContent = fmtDate(period.start) + ' – ' + fmtDate(period.end) + ' · ' + period.weeks + ' weeks';
    $('periodPay').textContent = period.payDate ? 'Bonus pay date ' + fmtDate(period.payDate)
      : 'Bonus pay date not published for this year';
    $('periodCount').textContent = period.note || '';

    $('statPayout').textContent = money(p.payout);
    $('topbarPayout').innerHTML = '<span class="cap">Month to date</span><span class="amt">' + money(p.payout) + '</span>';
    var sub = p.trainingApplies
      ? 'Training pay (' + money(p.trainingPay) + ') exceeds commissions'
      : 'Commissions + bonuses';
    if (p.reservePercent > 0) { sub += ' · ' + money(p.netPayout) + ' after ' + p.reservePercent + '% reserve'; }
    $('statPayoutSub').textContent = sub;

    $('statCommission').textContent = money(p.commission);
    $('statCommissionSub').textContent = p.saleCount + (p.saleCount === 1 ? ' contract' : ' contracts') +
      (p.totalCommission !== p.commission ? ' · ' + money(p.totalCommission) + ' before splits' : '');

    $('statBonus').textContent = money(p.cemeteryBonus + p.funeralBonus);
    var bparts = [];
    if (p.cemeteryTier) { bparts.push('Cemetery ' + p.cemeteryTier.rate + '%'); }
    if (p.funeralTier) { bparts.push('Funeral ' + p.funeralTier.rate + '%'); }
    $('statBonusSub').textContent = bparts.length ? bparts.join(' · ') : 'No bonus tier reached';

    $('statLand').textContent = money(p.landSaleBonus);
    $('statLandSub').textContent = p.landSaleAwards + ' of ' + R.LAND_SALE_BONUS_MAX_PER_MONTH + ' contracts';

    // Cemetery meter: marks at 40% and 60% of the bar for the 20k/30k tiers.
    var cemStops = [{ value: 0, pos: 0 }, { value: 20000, pos: 40 }, { value: 30000, pos: 60 }, { value: 50000, pos: 100 }];
    $('cemVolume').textContent = money(p.cemeteryVolume);
    $('cemFill').style.width = meterPosition(p.cemeteryVolume, cemStops) + '%';
    $('cemNote').innerHTML = p.cemeteryTier
      ? '<strong>' + p.cemeteryTier.rate + '% tier reached</strong> — ' + money(p.cemeteryBonus) + ' bonus' +
        (p.cemeteryNext ? '. ' + money(p.cemeteryNext.remaining) + ' more reaches ' + p.cemeteryNext.tier.rate + '%.' : '. Top tier.')
      : (p.cemeteryNext ? money(p.cemeteryNext.remaining) + ' more reaches the ' + p.cemeteryNext.tier.rate + '% tier.' : 'No bonus tier reached yet.');

    var funStops = [{ value: 0, pos: 0 }, { value: 24999, pos: 55.554 }, { value: 35000, pos: 77.778 }, { value: 45000, pos: 100 }];
    $('funVolume').textContent = money(p.funeralVolume);
    $('funFill').style.width = meterPosition(p.funeralVolume, funStops) + '%';
    $('funNote').innerHTML = p.funeralTier
      ? '<strong>' + p.funeralTier.rate + '% tier reached</strong> — ' + money(p.funeralBonus) + ' bonus' +
        (p.funeralNext ? '. ' + money(p.funeralNext.remaining) + ' more reaches ' + p.funeralNext.tier.rate + '%.' : '. Top tier.')
      : (p.funeralNext ? money(p.funeralNext.remaining) + ' more reaches the ' + p.funeralNext.tier.rate + '% tier.' : 'No bonus tier reached yet.');

    var alerts = $('alerts');
    if (p.warnings.length) {
      alerts.hidden = false;
      alerts.innerHTML = p.warnings.map(function (w) {
        return '<div class="alert"><span>⚠</span><span><b>' + esc(w.customer || w.id) + '</b> — ' + esc(w.message) + '</span></div>';
      }).join('');
    } else {
      alerts.hidden = true;
      alerts.innerHTML = '';
    }

    renderSales(p, sales);
  }

  function renderSales(p, sales) {
    var box = $('salesList');
    if (!sales.length) {
      box.innerHTML = '<p class="empty">No sales recorded in this sales month yet.</p>';
      return;
    }

    box.innerHTML = p.results.map(function (r) {
      var meta = [fmtDate(r.date)];
      if (r.contractNumber) { meta.push('#' + r.contractNumber); }
      if (r.track === 'cemetery') { meta.push(r.financingOptionLabel); }
      else { meta.push((r.subtype === 'trust' ? 'PN Trust' : 'Insurance') + ' · age band ' + r.ageBand); }
      meta.push(money(r.contractAmount));

      var badges = '<span class="badge ' + (r.track === 'cemetery' ? 'cemetery' : 'funeral') + '">' +
        (r.track === 'cemetery' ? 'Cemetery' : 'Funeral') + '</span>';
      if (r.landSaleAwarded) { badges += '<span class="badge land">+$100 land</span>'; }
      if (r.isSplit) { badges += '<span class="badge">' + r.splitPercent + '% split</span>'; }
      if (r.warnings.length) { badges += '<span class="badge flag">' + r.warnings.length + '</span>'; }

      var lines = r.lines.filter(function (l) { return l.amount; }).map(function (l) {
        return '<div class="pline"><div class="pline-main"><span>' + esc(l.short || l.label) +
          '</span><span class="amt">' + money(l.commission) + '</span></div>' +
          '<div class="pline-calc">' + money(l.amount) + ' × ' + pctText(l.rate) + '</div>' +
          l.steps.map(function (s) { return '<div class="pline-step">↳ ' + esc(s.label) + '</div>'; }).join('') +
          '</div>';
      }).join('');

      var foot = '';
      if (r.isSplit) { foot += '<div>Contract total ' + money(r.totalCommission) + ' · your share ' + money(r.commission) + '</div>'; }
      foot += '<div>Bonus volume ' + money(r.cemeteryVolume + r.funeralVolume) + '</div>';
      r.volumeNotes.forEach(function (n) { foot += '<div>' + esc(n) + '</div>'; });
      if (r.notes) { foot += '<div>' + esc(r.notes) + '</div>'; }
      r.warnings.forEach(function (w) { foot += '<div class="warn">⚠ ' + esc(w) + '</div>'; });

      return '<details class="sale" data-id="' + esc(r.id) + '">' +
        '<summary><span class="sale-name">' + esc(r.customer || 'Unnamed contract') + badges + '</span>' +
        '<span class="sale-meta">' + esc(meta.join(' · ')) + '</span>' +
        '<span class="sale-amt">' + money(r.commission) + '</span></summary>' +
        '<div class="sale-body"><div class="preview-lines">' + lines + '</div>' +
        '<div class="preview-foot">' + foot + '</div>' +
        '<div class="sale-actions"><button type="button" class="link-btn" data-act="edit">Edit</button>' +
        '<button type="button" class="link-btn" data-act="dup">Duplicate</button>' +
        '<button type="button" class="link-btn" data-act="del">Delete</button></div></div></details>';
    }).join('');
  }

  function render() {
    renderPeriodSelect();
    renderDashboard();
    renderPreview();
    renderBanners();
    renderBackupNote();
  }

  /* ---------------------------------------------------------------- *
   * Reference tables
   * ---------------------------------------------------------------- */

  function renderReference() {
    function table(headers, rows) {
      return '<div class="ref-scroll"><table class="ref"><thead><tr>' +
        headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }
    var na = function (v) { return v == null ? 'N/A' : v + '%'; };

    var html = '<div class="ref-block"><h3>Cemetery commissions</h3>' +
      table(['Lead source', 'Property (w/ ACH)', 'Property (no ACH)', 'Designed mdse (w/ ACH)', 'Designed mdse (no ACH)'],
        R.CEMETERY_LEAD_SOURCES.map(function (r) {
          return [esc(r.label), na(r.propertyAch), na(r.propertyNoAch), na(r.merchAch), na(r.merchNoAch)];
        })) +
      '<ul class="ref-notes">' +
      '<li>No commission or volume on AN interment authorization fees (O/Cs). PN interment authorization fees pay 5%.</li>' +
      '<li>Unlined vaults pay 0% commission.</li>' +
      '<li>Undesigned merchandise pays the listed percentage less 5%, to a minimum of 0%.</li>' +
      '<li>No contract may be written for longer than 60 months.</li>' +
      '<li>Maximum 10% commission on large sales over $25,000 — the actual percentage is set by Corporate.</li>' +
      '</ul></div>';

    html += '<div class="ref-block"><h3>Financing options (company sheet)</h3>' +
      table(['Financing option', 'Property %', 'Other cemetery %'],
        R.FINANCING_OPTIONS.map(function (f) {
          var rates = R.financingOptionRates(f.id);
          return [esc(f.label) + (f.offSheet ? ' *' : ''), rates.property + '%', rates.otherCemetery + '%'];
        })) +
      '<ul class="ref-notes"><li>* Not on the company dropdown. Schedule A pays 0% on an under-10%-down contract with no ACH draft.</li></ul></div>';

    html += '<div class="ref-block"><h3>Insurance commissions</h3>' +
      table(['Age on date of issue'].concat(R.INSURANCE_PRODUCTS.map(function (p) { return esc(p.label); })),
        R.INSURANCE_BANDS.map(function (b) {
          return [b.label].concat(R.INSURANCE_PRODUCTS.map(function (p) { return b[p.id] + '%'; }));
        })) +
      '<ul class="ref-notes">' +
      '<li>7 year policies and policies without auto-pay should not be sold.</li>' +
      '<li>eFuneral has been cancelled — no eFuneral policies should be sold.</li>' +
      '</ul></div>';

    html += '<div class="ref-block"><h3>PN trust commissions</h3>' +
      table(['Age on contract date', 'Single pay or terms w/ ACH', 'Terms without ACH'],
        R.TRUST_BANDS.map(function (b) { return [b.label, b.ach + '%', b.noAch + '%']; })) +
      '<ul class="ref-notes">' +
      '<li>Terms are not to exceed 60 months.</li>' +
      '<li>If a PN trust turns AN within 30 days, commission is charged back to 4% for purchasers up to 80, and 2% over 80.</li>' +
      '</ul></div>';

    html += '<div class="ref-block"><h3>Bonuses</h3>' +
      table(['Monthly cemetery pre need volume', 'Bonus'],
        R.CEMETERY_BONUS_TIERS.slice().reverse().map(function (t) { return [t.label.split(' = ')[0], t.rate + '%']; })) +
      table(['Monthly funeral pre need volume (insurance + trust)', 'Bonus'],
        R.FUNERAL_BONUS_TIERS.slice().reverse().map(function (t) { return [t.label.split(' = ')[0], t.rate + '%']; })) +
      '<ul class="ref-notes">' +
      '<li>Volume toward bonus from a large sale will not exceed $25,000.</li>' +
      '<li>Contracts with less than 10% down and no automatic payment setup do not count toward volume.</li>' +
      '<li>Land sale bonus: $100 for each of the first three processed preneed contracts including a preneed right of burial at or above the location\'s Heritage Certificate value. Sales to a relative are excluded.</li>' +
      '<li>Training pay: $100 daily rate for up to four weeks — training pay or commissions, whichever is greater.</li>' +
      '</ul></div>';

    html += '<div class="ref-block"><h3>Company generated leads &amp; appointments</h3>' +
      table(['Employee', 'Cemetery', 'Funeral'],
        R.ROLES.map(function (r) {
          return [esc(r.label) + (r.flatRate ? '' : ' (take away)'), r.cemetery.toFixed(2) + '%', r.funeral.toFixed(2) + '%'];
        })) +
      '<ul class="ref-notes"><li>Includes but is not limited to: ' + R.COMPANY_LEAD_TRIGGERS.map(esc).join('; ') + '.</li>' +
      '<li>Contracts with more than one of these adjustments are only adjusted one time.</li></ul></div>';

    html += '<div class="ref-block"><h3>Sales month calendar</h3>' +
      table(['Sales month', 'Weeks', 'Date range', 'Bonus pay date'],
        R.SALES_CALENDAR_2025.map(function (p) {
          return [p.label, String(p.weeks), fmtDate(p.start) + ' – ' + fmtDate(p.end), fmtDate(p.payDate)];
        })) +
      '<ul class="ref-notes"><li>Bonuses are paid before the 30 day cancellation window expires for some contracts. The company reserves the right to reverse or adjust a paid bonus if the contract cancels or is deemed unenforceable.</li>' +
      '<li>Sales months outside 2025 are projected from this calendar\'s 5-4-4 pattern and are marked "est." — check them against the published Schedule A.</li></ul></div>';

    $('referenceTables').innerHTML = html;
  }

  /* ---------------------------------------------------------------- *
   * Export
   * ---------------------------------------------------------------- */

  /*
   * Hand a file to the viewer.
   *
   * When the page runs as a published artifact the host provides a save API;
   * the anchor-download fallback is blocked in that frame. Elsewhere — the
   * standalone HTML file, a plain web server — the anchor is the only route.
   */
  function download(name, text, type, done) {
    var host = window.claude && window.claude.downloads;
    if (host && typeof host.save === 'function') {
      host.save({ filename: name, data: text })
        .then(function () { if (done) { done(true); } })
        .catch(function (err) {
          // A declined save is a normal outcome, not a failure to report.
          if (!(err && err.code === 'user_rejected')) {
            alert('That file could not be saved: ' + ((err && err.message) || 'unknown error'));
          }
          if (done) { done(false); }
        });
      return;
    }
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    if (done) { done(true); }
  }

  function exportJson() {
    download('commission-backup-' + todayIso() + '.json', JSON.stringify(state, null, 2), 'application/json',
      function (ok) {
        if (!ok) { return; }
        state.lastBackupAt = Date.now();
        state.backupSnoozedAt = null;
        renderBanners();
        renderBackupNote();
        save(true);
      });
  }

  function renderBackupNote() {
    var since = daysSinceBackup();
    var el = $('backupNote');
    if (!el) { return; }
    el.textContent = since === null
      ? 'No backup downloaded yet.'
      : since === 0 ? 'Last backup: today.' : 'Last backup: ' + since + ' day' + (since === 1 ? '' : 's') + ' ago.';
  }

  function exportCsv() {
    var period = activePeriod();
    var sales = salesInPeriod(period);
    var p = R.calcPeriod(sales, settingsFor(period));

    var cell = function (v) {
      var s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var amountOf = function (r, type) {
      var l = r.lines.filter(function (x) { return x.type === type; })[0];
      return l ? l.amount : 0;
    };

    var rows = [[
      'Contract #', 'Purchaser Name', 'Date', 'Funeral Volume',
      'Property Volume (GROUND)', 'Property Volume (CRYPT)', 'Property Volume (NICHE)',
      'Other Cemetery Volume', 'O&C Amount', 'Financing Option',
      'Total Commission $', 'Split?', 'Paid Commission $ (before reserve)', 'Notes'
    ]];

    p.results.forEach(function (r) {
      rows.push([
        r.contractNumber, r.customer, fmtDate(r.date),
        r.track === 'funeral' ? r.contractAmount : '',
        amountOf(r, 'property_ground') || '',
        amountOf(r, 'property_crypt') || '',
        amountOf(r, 'property_niche') || '',
        (amountOf(r, 'other_cemetery') + amountOf(r, 'undesigned_merch') + amountOf(r, 'unlined_vault')) || '',
        (amountOf(r, 'oc_pn') + amountOf(r, 'oc_an')) || '',
        r.track === 'cemetery' ? r.financingOptionLabel : (r.subtype === 'trust' ? 'TRUST' : 'INSURANCE'),
        r.totalCommission,
        r.isSplit ? r.splitPercent + '%' : '',
        r.commission,
        r.notes
      ]);
    });

    rows.push([]);
    rows.push(['', '', '', '', '', '', '', '', '', 'Commissions', '', p.commission, '']);
    rows.push(['', '', '', '', '', '', '', '', '', 'Cemetery volume', p.cemeteryVolume, p.cemeteryBonus,
      p.cemeteryTier ? p.cemeteryTier.rate + '% bonus' : 'no tier']);
    rows.push(['', '', '', '', '', '', '', '', '', 'Funeral volume', p.funeralVolume, p.funeralBonus,
      p.funeralTier ? p.funeralTier.rate + '% bonus' : 'no tier']);
    rows.push(['', '', '', '', '', '', '', '', '', 'Land sale bonus', p.landSaleAwards, p.landSaleBonus, '']);
    rows.push(['', '', '', '', '', '', '', '', '', 'Total payout', '', p.payout, '']);
    if (p.reservePercent > 0) {
      rows.push(['', '', '', '', '', '', '', '', '', 'After ' + p.reservePercent + '% reserve', '', p.netPayout, '']);
    }

    var csv = rows.map(function (r) { return r.map(cell).join(','); }).join('\r\n');
    download('commission-' + period.label.replace(/\s+/g, '-').toLowerCase() + '.csv', csv, 'text/csv');
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function onFormInput() {
    state.draft = readForm();
    renderPreview();
    save();
  }

  function resetForm() {
    state.editingId = null;
    state.draft = null;
    financingTouched = false;
    writeForm({ category: state.category, date: $('fDate').value || todayIso() });
    $('entryTitle').textContent = 'New sale';
    $('submitBtn').textContent = 'Add sale';
    $('cancelEdit').hidden = true;
    renderPreview();
    save();
  }

  function init() {
    checkStorage();
    load();

    $('scheduleTag').textContent = R.SCHEDULE_VERSION;
    if (storageWorks === false) {
      flagStorage('This browser is not saving anything. Open the page directly in Safari or Chrome, or add it to your home screen.');
    }

    R.INSURANCE_PRODUCTS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + (p.discontinued ? ' — cancelled' : '') + (p.discouraged ? ' — do not sell' : '');
      $('iProduct').appendChild(o);
    });
    R.ROLES.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label;
      $('sRole').appendChild(o);
    });

    // Settings
    applyTheme();
    watchSystemTheme();
    $('sTheme').value = state.settings.theme || 'light';
    $('sRole').value = state.settings.roleId;
    $('sLocation').value = state.settings.location || '';
    $('sHeritage').value = state.settings.heritageCertificateValue || '';
    $('sTraining').value = '';
    renderRoleHint();

    // Restore the in-progress form if there was one.
    if (state.draft) {
      writeForm(state.draft);
      financingTouched = !!state.draft.financingOption;
    } else {
      writeForm({ category: state.category, date: todayIso() });
    }
    if (state.editingId) {
      $('entryTitle').textContent = 'Editing sale';
      $('submitBtn').textContent = 'Save changes';
      $('cancelEdit').hidden = false;
    }

    renderReference();
    render();
    syncTrainingField();

    /* --- form --- */
    $('saleForm').addEventListener('input', function (e) {
      if (e.target.id === 'fFinancing') { financingTouched = true; }
      if (['fAtNeed', 'fHasAch', 'fDown', 'fTerm'].indexOf(e.target.id) !== -1 ||
          AMOUNT_FIELDS.some(function (p) { return p[0] === e.target.id; }) || e.target.id === 'aOc') {
        refreshFinancingOptions();
      }
      if (e.target.id === 'fDate') { updateDateHint(); }
      onFormInput();
    });
    $('saleForm').addEventListener('change', function () { onFormInput(); });

    $('saleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var sale = readForm();
      if (!R.calcSale(sale, settingsFor(activePeriod())).contractAmount) {
        alert('Enter an amount before saving this sale.');
        return;
      }
      if (state.editingId) {
        state.sales = state.sales.map(function (s) {
          return s.id === state.editingId ? Object.assign({}, sale, { id: state.editingId }) : s;
        });
      } else {
        sale.id = uid();
        state.sales.push(sale);
        // Follow the sale into its sales month so the totals shown are its own.
        var p = periodFor(sale.date);
        if (p) { state.activePeriod = R.periodKey(p); }
      }
      resetForm();
      render();
      save(true);
    });

    $('clearForm').addEventListener('click', resetForm);
    $('cancelEdit').addEventListener('click', resetForm);

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        state.category = t.dataset.category;
        setCategoryTabs();
        onFormInput();
      });
    });

    /* --- period --- */
    $('periodSelect').addEventListener('change', function () {
      state.activePeriod = $('periodSelect').value;
      syncTrainingField();
      render();
      save();
    });

    /* --- sales list --- */
    $('salesList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) { return; }
      var id = btn.closest('.sale').dataset.id;
      var sale = state.sales.filter(function (s) { return s.id === id; })[0];
      if (!sale) { return; }

      if (btn.dataset.act === 'edit') {
        state.editingId = id;
        writeForm(sale);
        financingTouched = !!sale.financingOption;
        $('entryTitle').textContent = 'Editing sale';
        $('submitBtn').textContent = 'Save changes';
        $('cancelEdit').hidden = false;
        renderPreview();
        save();
        document.querySelector('.entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (btn.dataset.act === 'dup') {
        var copy = Object.assign({}, sale, { id: uid(), contractNumber: '', customer: (sale.customer || '') + ' (copy)' });
        state.sales.push(copy);
        render();
        save(true);
      } else if (btn.dataset.act === 'del') {
        if (!confirm('Delete this sale? ' + (sale.customer || sale.contractNumber || 'Unnamed contract'))) { return; }
        state.sales = state.sales.filter(function (s) { return s.id !== id; });
        if (state.editingId === id) { resetForm(); }
        render();
        save(true);
      }
    });

    $('exportCsv').addEventListener('click', exportCsv);
    $('exportJson').addEventListener('click', exportJson);
    $('drawerExport').addEventListener('click', exportJson);

    $('banners').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-banner]');
      if (!btn) { return; }
      var act = btn.dataset.banner;
      if (act === 'backup') { exportJson(); return; }
      if (act === 'snooze') { state.backupSnoozedAt = Date.now(); }
      if (act === 'gotit') { state.installTipDismissed = true; }
      if (act === 'how') { alert(installInstructions()); return; }
      renderBanners();
      save(true);
    });

    /* --- settings drawer --- */
    var openDrawer = function (open) {
      $('drawer').hidden = !open;
      $('drawerBackdrop').hidden = !open;
    };
    $('settingsBtn').addEventListener('click', function () { openDrawer(true); });
    $('closeDrawer').addEventListener('click', function () { openDrawer(false); });
    $('drawerBackdrop').addEventListener('click', function () { openDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('drawer').hidden) { openDrawer(false); }
    });

    ['sTheme', 'sRole', 'sLocation', 'sHeritage', 'sTraining'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        state.settings.theme = $('sTheme').value;
        applyTheme();
        state.settings.roleId = $('sRole').value;
        state.settings.location = $('sLocation').value;
        state.settings.heritageCertificateValue = $('sHeritage').value;
        state.settings.trainingDays = state.settings.trainingDays || {};
        state.settings.trainingDays[R.periodKey(activePeriod())] = $('sTraining').value;
        renderRoleHint();
        render();
        save();
      });
    });

    $('importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) { return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          if (!parsed || !Array.isArray(parsed.sales)) { throw new Error('not a backup file'); }
          if (!confirm('Replace the ' + state.sales.length + ' sale(s) in this browser with the ' +
              parsed.sales.length + ' sale(s) in this backup?')) { return; }
          state = Object.assign(defaultState(), parsed);
          state.settings = mergeSettings(parsed.settings);
          applyTheme();
          writeForm(state.draft || { category: state.category, date: todayIso() });
          $('sTheme').value = state.settings.theme || 'light';
          $('sRole').value = state.settings.roleId;
          $('sLocation').value = state.settings.location || '';
          $('sHeritage').value = state.settings.heritageCertificateValue || '';
          render();
          syncTrainingField();
          save(true);
          openDrawer(false);
        } catch (err) {
          alert('That file could not be read as a backup.');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('resetAll').addEventListener('click', function () {
      if (!confirm('Delete every sale and setting stored in this browser? Download a backup first if you might want this data back.')) { return; }
      if (!confirm('Last chance — this cannot be undone. Delete all ' + state.sales.length + ' sale(s)?')) { return; }
      state = defaultState();
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(BACKUP_KEY);
      writeForm({ category: 'cemetery', date: todayIso() });
      render();
      save(true);
    });

    /*
     * Rescue the in-progress form from a closing tab.
     *
     * Sales and settings are already written on every change, so the only
     * thing at risk here is the half-typed entry form. Writing the whole of
     * this tab's state would clobber sales another tab saved in the meantime,
     * so layer only this tab's UI state onto whatever storage currently holds.
     */
    window.addEventListener('beforeunload', function () {
      try {
        var current = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || state;
        current.draft = readForm();
        current.editingId = state.editingId;
        current.activePeriod = state.activePeriod;
        current.category = state.category;
        localStorage.setItem(STORE_KEY, JSON.stringify(current));
      } catch (err) { /* a closing tab has nowhere left to report this */ }
    });

    /* Another tab saved. Adopt its sales and settings without disturbing what
     * is being typed here. */
    window.addEventListener('storage', function (e) {
      if (e.key !== STORE_KEY || !e.newValue) { return; }
      try {
        var incoming = JSON.parse(e.newValue);
        if (!incoming || !Array.isArray(incoming.sales)) { return; }
        state.sales = incoming.sales;
        state.settings = mergeSettings(incoming.settings);
        applyTheme();
        $('sTheme').value = state.settings.theme || 'light';
        $('sRole').value = state.settings.roleId;
        $('sLocation').value = state.settings.location || '';
        $('sHeritage').value = state.settings.heritageCertificateValue || '';
        renderRoleHint();
        syncTrainingField();
        render();
      } catch (err) { /* ignore an unreadable write from another tab */ }
    });

    updateDateHint();
  }

  function renderRoleHint() {
    var role = R.ROLES.filter(function (r) { return r.id === state.settings.roleId; })[0];
    if (!role) { return; }
    $('roleHint').textContent = role.flatRate
      ? 'Earns ' + role.cemetery + '% on cemetery and ' + role.funeral + '% on funeral company generated business only.'
      : 'On a company generated lead, ' + role.cemetery.toFixed(2) + ' points come off cemetery commission and ' +
        role.funeral.toFixed(2) + ' points off funeral commission.';
  }

  function syncTrainingField() {
    var key = R.periodKey(activePeriod());
    $('sTraining').value = (state.settings.trainingDays || {})[key] || '';
  }

  function updateDateHint() {
    var d = $('fDate').value;
    var p = periodFor(d);
    $('dateHint').textContent = p
      ? 'Falls in the ' + p.label + ' sales month (' + fmtDate(p.start) + ' – ' + fmtDate(p.end) + ')' +
        (p.estimated ? ' — estimated calendar' : '')
      : '';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
