const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// Execute the functions shipped in the page, with inputs supplied by each test.
function pageFunction(name) {
  const match = source.match(new RegExp('^      function ' + name + '\\([\\s\\S]*?^      }', 'm'));
  assert.ok(match, 'Missing function ' + name);
  return match[0];
}

function subject(overrides = {}) {
  const context = {
    config: { optional: { checked: true }, 'kzp-enabled': { checked: false } },
    goals: ['maximum', 'manual', 'off'].map(value => ({ checked: value === 'maximum', value })),
    bonuses: [],
    deductions: [],
    paychecks: Array.from({ length: 24 }, (_, index) => ({
      index,
      year: 2026 + Math.floor(index / 12),
      month: index % 12,
      label: String(index + 1),
      date: new Date(Date.UTC(2026, index + 1, 0, 12)).toISOString().slice(0, 10),
      gross: 1450000,
      enteredNet: null,
    })),
    workplaceDeductions: () => Array(24).fill(0),
    value: key => ({ initial: '0', confirmed: '', floor: '', source: 'both' })[key],
    count: key => ({ start: 0, end: 11 })[key],
    cents: () => 0,
    ...overrides,
  };
  for (const key of ['initial', 'confirmed', 'floor']) context.config[key] = { checkValidity: () => true };
  context.config['tax-2027'] ??= { value: 'current' };
  const originalValue = context.value;
  context.value = key => key === 'tax-2027' ? context.config[key].value : originalValue(key);
  const constants = ['amountFormat', 'numberFormat', 'inZloty', 'formatPercent', 'money', 'isoDate', 'pensionLimits', 'roundRate', 'wholeZloty', 'taxScales', 'monthGenitives', 'pensionDefaults', 'ppeEmployeeLimits'];
  const declarations = constants.map(name => {
    const match = source.match(new RegExp('^      const ' + name + ' = .+;$', 'm'));
    assert.ok(match, 'Missing constant ' + name);
    return match[0];
  });
  const functions = ['defaultPayDate', 'planStartDate', 'kzpInputError', 'progressiveTax', 'taxForScale', 'tax2027Description', 'monthPayroll', 'payrollTimeline', 'collectPeriods', 'simulate', 'calculatePlan', 'failureMessage', 'monthWithYear', 'availableBonusPeriods', 'chartYears', 'populatePaycheck', 'enteredAmount', 'pensionConfig', 'pensionNumber', 'pensionInputError', 'pensionDeductionKind', 'pensionActive', 'pensionTimeline'];
  const code = [...declarations, ...functions.map(pageFunction), 'globalThis.subject = { ' + functions.join(', ') + ', money, formatPercent, pensionDefaults };'].join('\n');
  vm.runInNewContext(code, context);
  return { ...context.subject, context };
}

test('a bonus before the first salary appears once and is available on payday', () => {
  const app = subject();
  app.context.paychecks[0].date = '2026-01-29';
  const baseline = app.calculatePlan();
  app.context.bonuses.push({ amount: 500000, date: '2026-01-10', link: null, optional: false });
  const timeline = app.payrollTimeline();
  const plan = app.calculatePlan();
  const earlyNet = timeline.separate[0].amount;
  assert.ok(earlyNet > 0);
  assert.equal(plan.periods[0].earlier, earlyNet);
  assert.equal(plan.periods[0].received, timeline.pays[0].receivedTransfer + earlyNet);
  assert.equal(plan.periods.slice(1).reduce((sum, row) => sum + row.earlier, 0), 0);
  assert.ok(plan.target >= baseline.target);
  assert.equal(plan.projection.failure, null);
  const receipts = plan.periods.reduce((sum, row) => sum + row.received, 0);
  assert.equal(receipts, plan.target * 12 + plan.projection.closing + plan.projection.outside);
  assert.ok(app.simulate(plan.periods, plan.target + 1, 0, 0, 'both').failure);
});

test('the first selected month includes its early bonus, with source restrictions respected', () => {
  const app = subject();
  app.context.bonuses.push({ amount: 500000, date: '2026-06-10', link: null, optional: false });
  const wholeYear = app.collectPeriods(0, 11);
  assert.equal(wholeYear[5].earlier, 0);
  assert.ok(wholeYear[4].later > 0);
  const fromJune = app.collectPeriods(5, 11);
  assert.ok(fromJune[0].earlier > 0);
  assert.equal(fromJune[0].received, wholeYear[5].received + fromJune[0].earlier);
  for (const mode of ['salary', 'bonus', 'both']) {
    const result = app.simulate(fromJune, 0, 0, 0, mode);
    const receipts = fromJune.reduce((sum, row) => sum + row.received, 0);
    assert.equal(result.failure, null);
    assert.equal(result.closing + result.outside, receipts);
  }
});

test('a later bonus cannot fund an earlier salary allocation', () => {
  const app = subject();
  const row = { index: 0, salary: 400000, earlier: 0, sameDay: 0, later: 200000 };
  assert.equal(app.simulate([row], 600000, 0, 0, 'both').failure.shortfall, 200000);
  row.earlier = row.later;
  row.later = 0;
  assert.equal(app.simulate([row], 600000, 0, 0, 'both').failure, null);
  assert.equal(app.simulate([row], 600000, 0, 0, 'salary').failure.shortfall, 200000);
});

test('the reserve before, signed change and reserve after reconcile in every source mode', () => {
  const app = subject();
  for (const sameDay of [0, 200000]) {
    for (const earlier of [0, 100000]) {
      for (const mode of ['salary', 'bonus', 'both']) {
        const row = { index: 0, salary: 800000, earlier, sameDay, later: 30000 };
        const result = app.simulate([row], 900000, 500000, 0, mode);
        const balance = result.balances.get(0);
        assert.equal(balance.before, 500000);
        assert.equal(balance.before + balance.atPayday, balance.after);
        assert.equal(balance.before + balance.forPeriod, balance.atEnd);
      }
    }
  }
});

test('money always includes two fractional digits', () => {
  const app = subject();
  const normalize = text => text.replace(/\s/g, ' ');
  assert.equal(normalize(app.money(383720)), '3 837,20 zł');
  assert.equal(normalize(app.money(12550)), '125,50 zł');
  assert.equal(normalize(app.money(0)), '0,00 zł');
});

test('excess deductions describe negative net without claiming to exceed gross', () => {
  const app = subject({ workplaceDeductions: () => Array(24).fill(1200000) });
  const result = app.calculatePlan();
  assert.match(result.error, /kwota do wypłaty jest ujemna/);
  assert.doesNotMatch(result.error, /przekraczają kwotę brutto/);
  assert.equal(result.target, null);
});

test('percentages retain precision without monetary trailing zeroes', () => {
  const app = subject();
  assert.equal(app.formatPercent(200), '2%');
  assert.equal(app.formatPercent(250), '2,5%');
  assert.equal(app.formatPercent(225), '2,25%');
});

test('moving the first salary into March preserves a bonus paid in February', () => {
  const app = subject();
  app.context.paychecks[1].date = '2026-03-02';
  app.context.bonuses.push({ amount: 500000, date: '2026-02-10', link: null, optional: false });
  const periods = app.collectPeriods(1, 11);
  const bonus = app.payrollTimeline().separate[0];
  assert.equal(app.planStartDate(periods[0]), '2026-02-01');
  assert.equal(periods[0].earlier, bonus.amount);
  assert.equal(periods[0].received, periods[0].salary + bonus.amount);
  for (const mode of ['salary', 'bonus', 'both']) {
    const result = app.simulate(periods, 0, 0, 0, mode);
    assert.equal(result.failure, null);
    assert.equal(result.closing + result.outside, periods.reduce((sum, row) => sum + row.received, 0));
  }
});

function storageSubject(storage = new Map(), failWrites = false, edited = true) {
  const app = subject();
  const context = app.context;
  for (const pay of context.paychecks) {
    pay.date = app.defaultPayDate(pay.index);
    pay.reason = '';
  }
  context.initialPaychecks = context.paychecks.map(pay => ({ ...pay }));
  const values = {
    start: '0', end: '11', source: 'both', initial: '0', confirmed: '', floor: '', manual: '', optional: true,
    'kzp-enabled': false, 'kzp-start': '0', 'kzp-savings': '200', 'kzp-initial': '0', 'kzp-debt': '0', 'kzp-rate': '0',
    'pay-from': '0', 'pay-gross': '14500',
    'tax-2027': 'current',
    ...app.pensionDefaults,
  };
  context.config = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'boolean' ? { type: 'checkbox', checked: value } : { value }]));
  for (const key of ['kzp-savings', 'kzp-initial', 'kzp-debt', 'kzp-rate']) {
    context.config[key].checkValidity = () => Number(context.config[key].value) >= 0 && Number(context.config[key].value) <= 10000000;
  }
  context.salaryChanges = new Map([[0, 1450000]]);
  context.deductions = [];
  context.chosen = 5;
  context.ui = { 'storage-status': {}, 'storage-clear': { hidden: true }, 'demo-label': {} };
  context.window = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('Storage unavailable');
      storage.set(key, value);
    },
  } };
  const declarations = ['storageKey', 'savedConfigKeys'].map(name => source.match(new RegExp('^      const ' + name + ' = .+;$', 'm'))[0]);
  const functions = ['storedPlan', 'validStoredPlan', 'applyStoredPlan', 'loadPlan', 'savePlan', 'markEdited'];
  vm.runInContext([...declarations, 'let savedSnapshot = null; let storageBlocked = false; let hasUserPlan = ' + edited + ';', ...functions.map(pageFunction), 'globalThis.storageSubject = { ' + functions.join(', ') + ' };'].join('\n'), context);
  return { ...context.storageSubject, context, storage };
}

test('salary history, bonuses, deductions, corrections and plan settings survive reload', () => {
  const app = storageSubject();
  app.context.salaryChanges.set(8, 1700000);
  app.context.paychecks[1].date = '2026-03-02';
  app.context.paychecks[1].reason = 'Termin potwierdzony';
  app.context.paychecks[1].enteredNet = 777777;
  app.context.bonuses.push({ type: 'quarterly', name: 'Premia kwartalna', amount: 123456, link: 4, date: '2026-06-21', optional: true });
  app.context.deductions.push({ kind: 'custom', name: 'Składka', amount: 250, percent: true, start: 0, end: 23, endInput: '', frequency: 'annual', interval: 12 });
  app.context.config.start.value = '1';
  app.context.config.end.value = '15';
  app.context.config.manual.value = '9 000,50';
  app.context.config['kzp-enabled'].checked = true;
  app.context.config['kzp-debt'].value = '1200';
  app.context.config['kzp-rate'].value = '200';
  for (const goal of app.context.goals) goal.checked = goal.value === 'manual';
  app.context.chosen = 4;
  app.savePlan();
  assert.equal(app.storage.size, 1);
  const saved = JSON.parse([...app.storage.values()][0]);
  assert.equal(app.validStoredPlan(saved), true);
  const restored = storageSubject(app.storage);
  restored.loadPlan();
  assert.equal(JSON.stringify(restored.storedPlan()), JSON.stringify(saved));
  assert.equal(restored.context.paychecks[7].gross, 1450000);
  assert.equal(restored.context.paychecks[8].gross, 1700000);
  assert.match(restored.context.ui['storage-status'].textContent, /Odtworzono/);
});

test('corrupt saved data stays intact instead of being replaced with sample data', () => {
  const storage = new Map([['kalkulator-wyplat.plan.v1', '{broken']]);
  const app = storageSubject(storage);
  app.loadPlan();
  app.savePlan();
  assert.equal(storage.get('kalkulator-wyplat.plan.v1'), '{broken');
  assert.match(app.context.ui['storage-status'].textContent, /nieczytelny/);
});

test('a write failure reports unsaved changes', () => {
  const app = storageSubject(new Map(), true);
  app.savePlan();
  assert.equal(app.storage.size, 0);
  assert.match(app.context.ui['storage-status'].textContent, /Nie udało się zapisać/);
});

test('a second tab cannot silently overwrite a newer saved plan', () => {
  const first = storageSubject();
  first.savePlan();
  const second = storageSubject(first.storage);
  second.loadPlan();
  first.context.config.initial.value = '1500';
  first.savePlan();
  const newer = [...first.storage.values()][0];
  second.context.config.initial.value = '1000';
  second.savePlan();
  assert.equal([...first.storage.values()][0], newer);
  assert.match(second.context.ui['storage-status'].textContent, /innej karcie/);
});

test('an early first salary includes same-day and following-day bonuses exactly once', () => {
  const app = subject();
  for (const pay of app.context.paychecks) pay.date = app.defaultPayDate(pay.index);
  app.context.paychecks[1].date = '2026-01-30';
  app.context.bonuses.push(
    { amount: 200000, date: '2026-01-30', link: null, optional: false },
    { amount: 300000, date: '2026-01-31', link: null, optional: false },
  );
  const timeline = app.payrollTimeline();
  const periods = app.collectPeriods(1, 11);
  const [sameDay, nextDay] = timeline.separate;
  assert.equal(periods[0].sameDay, sameDay.amount);
  assert.equal(periods[0].later, nextDay.amount);
  assert.equal(periods[0].earlier, 0);
  assert.equal(periods[0].received, timeline.pays[1].receivedTransfer + sameDay.amount + nextDay.amount);
  assert.equal(periods.slice(1).reduce((sum, row) => sum + row.separateGross, 0), 0);
  for (const mode of ['salary', 'bonus', 'both']) {
    const run = app.simulate(periods, 0, 0, 0, mode);
    assert.equal(run.failure, null);
    assert.equal(run.closing + run.outside, periods.reduce((sum, row) => sum + row.received, 0));
  }
});

test('invalid inactive KZP values do not block saving unrelated changes', () => {
  const app = storageSubject();
  app.context.config['kzp-savings'].value = '-200';
  app.context.config['kzp-debt'].value = '-1000';
  app.savePlan();
  app.context.salaryChanges.set(6, 1600000);
  app.context.config.manual.value = '7000';
  app.savePlan();
  assert.equal(app.storage.size, 1);
  const restored = storageSubject(app.storage, false, false);
  restored.loadPlan();
  assert.equal(restored.context.paychecks[6].gross, 1600000);
  assert.equal(restored.context.config.manual.value, '7000');
  assert.equal(restored.context.config['kzp-enabled'].checked, false);
});

test('browsing sample months does not create a saved user plan', () => {
  const app = storageSubject(new Map(), false, false);
  app.context.chosen = 8;
  app.savePlan();
  assert.equal(app.storage.size, 0);
  app.markEdited();
  app.savePlan();
  assert.equal(app.storage.size, 1);
});

test('enabling KZP identifies an invalid field instead of reporting a generic storage error', () => {
  const app = storageSubject();
  app.savePlan();
  const saved = [...app.storage.values()][0];
  app.context.config['kzp-savings'].value = '-200';
  app.context.config['kzp-enabled'].checked = true;
  const error = app.context.subject.kzpInputError();
  assert.equal(error.key, 'kzp-savings');
  assert.match(error.message, /Wkład miesięczny/);
  app.savePlan();
  assert.equal([...app.storage.values()][0], saved);
  assert.match(app.context.ui['storage-status'].textContent, /Wkład miesięczny/);
});

test('returning to the saved valid settings clears an obsolete KZP warning', () => {
  const app = storageSubject();
  app.context.config['kzp-savings'].value = '-200';
  app.savePlan();
  app.context.config['kzp-enabled'].checked = true;
  app.savePlan();
  assert.match(app.context.ui['storage-status'].textContent, /Wkład miesięczny/);
  app.context.config['kzp-enabled'].checked = false;
  app.savePlan();
  assert.match(app.context.ui['storage-status'].textContent, /Zapisano plan/);
});

// Fixed, independently calculated PLN fixtures: KUP 250, PIT reduction 300,
// no PPK/PPE, no voluntary deductions. Expectations never call payroll helpers.
for (const fixture of [
  { name: '10,000 gross below the PIT threshold', gross: 1000000, income: 0, pension: 0, contributions: 214761, tax: 70500, net: 714739 },
  { name: '10,000 gross crossing the PIT threshold from 115,000 income', gross: 1000000, income: 11500000, pension: 0, contributions: 214761, tax: 138100, net: 647139 },
  { name: '10,000 gross wholly in the 32 percent bracket', gross: 1000000, income: 15000000, pension: 0, contributions: 214761, tax: 238100, net: 547139 },
  { name: '10,000 gross reaching the 2026 pension cap exactly', gross: 1000000, income: 15000000, pension: 27260000, contributions: 214761, tax: 238100, net: 547139 },
  { name: '10,000 gross crossing the 2026 pension cap from 280,000', gross: 1000000, income: 15000000, pension: 28000000, contributions: 138936, tax: 264800, net: 596264 },
  { name: '10,000 gross after the 2026 pension cap, sickness remains', gross: 1000000, income: 15000000, pension: 28260000, contributions: 112295, tax: 274200, net: 613505 },
]) {
  test('payroll anchor: ' + fixture.name, () => {
    const { contributions, tax } = subject().monthPayroll(fixture.gross, fixture.income, fixture.pension, 2026);
    assert.equal(contributions, fixture.contributions);
    assert.equal(tax, fixture.tax);
    assert.equal(fixture.gross - contributions - tax, fixture.net);
  });
}

test('payroll anchor: two 5,000 gross transfers share monthly PIT and contribution calculations', () => {
  const app = subject();
  app.context.paychecks[0].gross = 500000;
  app.context.paychecks[0].date = '2026-01-15';
  app.context.bonuses.push({ amount: 500000, date: '2026-01-20', link: null, optional: false });
  const { pays, separate } = app.payrollTimeline();
  assert.equal(pays[0].receivedTransfer, 373819);
  assert.equal(separate[0].amount, 340920);
  assert.equal(pays[0].receivedTransfer + separate[0].amount, 714739);
  assert.equal(pays[0].tax + separate[0].tax, 70500);
  assert.equal(pays[0].contributions + separate[0].contributions, 214761);
});

test('payroll anchor: the January tax counters restart across years', () => {
  const app = subject();
  const { pays } = app.payrollTimeline();
  assert.equal(pays[0].receivedTransfer, 1021497);
  assert.equal(pays[12].receivedTransfer, 1021497);
  assert.equal(pays[0].tax, 117100);
  assert.equal(pays[12].tax, 117100);
});

// 2027 scenario anchors supplied for independent review: fixed cents, not
// expectations generated from the app. Social + health stay at 2,147.61 PLN.
for (const fixture of [
  { income: 11500000, tax: 70500, net: 714739, currentNet: 647139 },
  { income: 12500000, tax: 111100, net: 674139, currentNet: 547139 },
  { income: 13500000, tax: 171100, net: 614139, currentNet: 547139 },
  { income: 14500000, tax: 198100, net: 587139, currentNet: 547139 },
  { income: 15000000, tax: 238100, net: 547139, currentNet: 547139 },
]) {
  test('2027 scenario anchor: 10,000 gross with prior income ' + fixture.income / 100, () => {
    const app = subject();
    const current = app.monthPayroll(1000000, fixture.income, 0, 2027);
    assert.equal(1000000 - current.tax - current.contributions, fixture.currentNet);
    app.context.config['tax-2027'].value = 'draft3293';
    const scenario = app.monthPayroll(1000000, fixture.income, 0, 2027);
    assert.equal(scenario.tax, fixture.tax);
    assert.equal(scenario.contributions, 214761);
    assert.equal(1000000 - scenario.tax - scenario.contributions, fixture.net);
  });
}

test('2027 scenario anchor: one 50,000 gross transfer crosses both thresholds', () => {
  const app = subject();
  app.context.config['tax-2027'].value = 'draft3293';
  const payroll = app.monthPayroll(5000000, 12500000, 0, 2027);
  assert.equal(payroll.tax, 1082600);
  assert.equal(payroll.contributions, 1073805);
  assert.equal(5000000 - payroll.tax - payroll.contributions, 2843595);
});

for (const preset of ['current', 'draft3293']) {
  test('2027 pension limit anchor: crossing 300,990 with preset ' + preset, () => {
    const app = subject();
    app.context.config['tax-2027'].value = preset;
    const payroll = app.monthPayroll(1000000, 15000000, 29800000, 2027);
    assert.equal(payroll.pensionBase, 299000);
    assert.equal(payroll.contributions, 142932);
    assert.equal(payroll.tax, 263400);
    assert.equal(1000000 - payroll.tax - payroll.contributions, 593668);
  });
}

test('2027 sample plan anchor: scenario changes November, December and the whole-year maximum', () => {
  const app = subject({ count: key => ({ start: 12, end: 23 })[key] });
  const current = app.calculatePlan();
  assert.equal(current.target, 976238);
  app.context.config['tax-2027'].value = 'draft3293';
  const scenario = app.calculatePlan();
  assert.equal(scenario.periods[10].received, 962897);
  assert.equal(scenario.periods[11].received, 874297);
  assert.equal(scenario.target, 1004347);
  const sum = plan => plan.periods.reduce((total, row) => total + row.received, 0);
  assert.equal(sum(scenario) - sum(current), 337300);
  assert.equal(scenario.projection.failure, null);
  assert.ok(app.simulate(scenario.periods, scenario.target + 1, 0, 0, 'both').failure);
});

test('changing the 2027 preset leaves every 2026 transfer and deduction unchanged', () => {
  const app = subject();
  app.context.bonuses.push({ amount: 5000000, date: '2026-09-10', link: null, optional: false });
  const before = app.payrollTimeline();
  app.context.config['tax-2027'].value = 'draft3293';
  const after = app.payrollTimeline();
  assert.deepEqual(after.pays.slice(0, 12), before.pays.slice(0, 12));
  assert.deepEqual(after.separate, before.separate);
});

test('the tax preset follows the transfer year when a salary crosses New Year', () => {
  const app = subject();
  for (const pay of app.context.paychecks) pay.date = app.defaultPayDate(pay.index);
  app.context.paychecks[11].date = '2027-01-04';
  app.context.paychecks[11].gross = 20000000;
  const currentTax = app.payrollTimeline().pays[11].tax;
  app.context.config['tax-2027'].value = 'draft3293';
  const scenarioTax = app.payrollTimeline().pays[11].tax;
  assert.ok(scenarioTax < currentTax);
  assert.equal(scenarioTax, app.monthPayroll(20000000, 0, 0, 2027).tax);

  app.context.paychecks[11].date = app.defaultPayDate(11);
  app.context.paychecks[11].gross = 1450000;
  app.context.paychecks[12].date = '2026-12-31';
  const earlierScenario = app.payrollTimeline().pays[12];
  app.context.config['tax-2027'].value = 'current';
  assert.deepEqual(app.payrollTimeline().pays[12], earlierScenario);
});

test('2027 scenario anchor: two June transfers share the threshold, KUP and PIT reduction', () => {
  const app = subject();
  app.context.config['tax-2027'].value = 'draft3293';
  app.context.paychecks[17].date = '2027-06-15';
  app.context.paychecks[17].gross = 5000000;
  app.context.bonuses.push({ amount: 5000000, date: '2027-06-20', link: null, optional: false });
  const { pays, separate } = app.payrollTimeline();
  assert.equal(pays[17].tax + separate[0].tax, 1210700);
  assert.equal(pays[17].contributions + separate[0].contributions, 2147610);
  assert.equal(pays[17].receivedTransfer + separate[0].amount, 6641690);
});

for (const preset of ['current', 'draft3293']) {
  test('the selected 2027 preset survives plan restoration: ' + preset, () => {
    const app = storageSubject();
    app.context.config['tax-2027'].value = preset;
    app.savePlan();
    const restored = storageSubject(app.storage, false, false);
    restored.loadPlan();
    assert.equal(restored.context.config['tax-2027'].value, preset);
    assert.match(restored.context.ui['storage-status'].textContent, /Odtworzono/);
  });
}

test('a 0.5.1 plan without the new field restores with the default preset and all its data', () => {
  const app = storageSubject();
  app.context.salaryChanges.set(8, 1700000);
  app.context.bonuses.push({ type: 'award', name: 'Nagroda', amount: 123456, link: null, date: '2027-04-10', optional: false });
  app.context.deductions.push({ kind: 'custom', name: 'Składka', amount: 20000, percent: false, start: 0, end: 23, endInput: '', frequency: 'monthly', interval: 1 });
  app.context.config.end.value = '23';
  app.context.config.manual.value = '8000';
  app.savePlan();
  const legacy = JSON.parse([...app.storage.values()][0]);
  delete legacy.config['tax-2027'];
  const serialized = JSON.stringify(legacy);
  app.storage.set('kalkulator-wyplat.plan.v1', serialized);
  const restored = storageSubject(app.storage, false, false);
  restored.loadPlan();
  assert.match(restored.context.ui['storage-status'].textContent, /Odtworzono/);
  assert.equal(restored.context.config['tax-2027'].value, 'current');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.storedPlan())), { ...legacy, config: { ...legacy.config, 'tax-2027': 'current' } });
  assert.equal([...app.storage.values()][0], serialized);
  restored.savePlan();
  assert.equal(JSON.parse([...app.storage.values()][0]).config['tax-2027'], 'current');
});

test('unknown or malformed presets remain unreadable and are never silently replaced', () => {
  const app = storageSubject();
  app.savePlan();
  const saved = JSON.parse([...app.storage.values()][0]);
  for (const invalid of ['', 'draft3294', null, 3293, {}]) {
    saved.config['tax-2027'] = invalid;
    const serialized = JSON.stringify(saved);
    const storage = new Map([['kalkulator-wyplat.plan.v1', serialized]]);
    const restored = storageSubject(storage, false, false);
    restored.loadPlan();
    restored.savePlan();
    assert.match(restored.context.ui['storage-status'].textContent, /nieczytelny/);
    assert.equal([...storage.values()][0], serialized);
  }
});

test('month names after od and do use the Polish genitive with the correct year', () => {
  const app = subject();
  const months = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  for (const [month, name] of months.entries()) {
    assert.equal(app.monthWithYear(app.context.paychecks[month]), name + ' 2026');
    assert.equal(app.monthWithYear(app.context.paychecks[month + 12]), name + ' 2027');
  }
});

test('monthly bonus choices keep December 2025 and stop before the unpayable December 2027', () => {
  const app = subject();
  const options = app.availableBonusPeriods('monthly');
  assert.deepEqual(Array.from(options, row => row[0]), Array.from({ length: 24 }, (_, index) => index));
  assert.equal(options[0][1], 'Grudzień 2025');
  assert.equal(options.at(-1)[1], app.context.paychecks[22].label);
});

test('quarterly bonus choices retain IV 2025 and exclude IV 2027 paid after the supported years', () => {
  const app = subject();
  const options = app.availableBonusPeriods('quarterly');
  assert.deepEqual(Array.from(options, row => row[0]), [1, 4, 7, 10, 13, 16, 19, 22]);
  assert.equal(options[0][1], 'IV kwartał 2025');
  assert.equal(options.at(-1)[1], 'III kwartał 2027');
});

test('editing a confirmed transfer displays Polish money and saves the same cents', () => {
  const app = subject();
  app.context.chosen = 0;
  app.context.paychecks[0].enteredNet = 854632;
  app.context.ui = { 'payroll-month': {}, 'correction-feedback': {} };
  for (const key of ['pay-date', 'pay-reason', 'pay-net']) app.context.config[key] = {};
  app.context.showCorrectionFields = () => {};
  app.populatePaycheck();
  const displayed = app.context.config['pay-net'].value;
  assert.equal(displayed.replace(/\s/g, ' '), '8 546,32');
  app.context.value = key => app.context.config[key].value;
  assert.equal(app.enteredAmount('pay-net'), 854632);
});

test('chart year bands cover every month of full and partial multi-year plans', () => {
  const app = subject();
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(app.chartYears(app.context.paychecks)), [
    { year: 2026, start: 0, count: 12 },
    { year: 2027, start: 12, count: 12 },
  ]);
  assert.deepEqual(normalize(app.chartYears(app.context.paychecks.slice(10, 14))), [
    { year: 2026, start: 0, count: 2 },
    { year: 2027, start: 2, count: 2 },
  ]);
  assert.deepEqual(normalize(app.chartYears(app.context.paychecks.slice(12, 13))), [
    { year: 2027, start: 0, count: 1 },
  ]);
});

function pensionSubject(settings = {}, overrides = {}) {
  const app = subject(overrides);
  for (const [key, value] of Object.entries({ ...app.pensionDefaults, ...settings })) {
    app.context.config[key] = typeof value === 'boolean' ? { type: 'checkbox', checked: value } : { value: String(value) };
  }
  for (const pay of app.context.paychecks) {
    pay.date = app.defaultPayDate(pay.index);
    pay.gross = 1000000;
  }
  return app;
}

test('employer PPE income raises PIT and the threshold counter without increasing social or health bases', () => {
  const app = pensionSubject();
  const plain = app.monthPayroll(1000000, 0, 0, 2026);
  const benefit = app.monthPayroll(1000000, 0, 0, 2026, 70000);
  assert.equal(benefit.social, 137100);
  assert.equal(benefit.health, 77661);
  assert.equal(benefit.contributions, plain.contributions);
  assert.equal(benefit.pensionBase, plain.pensionBase);
  assert.equal(benefit.income - plain.income, 70000);
  assert.equal(benefit.tax, 78900);
  assert.equal(benefit.tax - plain.tax, 8400);
});

test('PPK anchor: standard employee and employer rates reduce 10,000 gross net to 6,929.39', () => {
  const app = pensionSubject({ 'ppk-enabled': true });
  const row = app.payrollTimeline().pays[0];
  assert.equal(row.ownPension, 20000);
  assert.equal(row.employerIncome, 15000);
  assert.equal(row.contributions, 214761);
  assert.equal(row.tax, 72300);
  assert.equal(row.receivedTransfer, 692939);
  assert.equal(row.incomeAfter, 852900);
});

test('PPK anchor: employer 150 increases PIT by 48 in the 32 percent bracket', () => {
  const app = pensionSubject();
  const row = app.monthPayroll(1000000, 15000000, 0, 2026, 15000);
  assert.equal(row.tax, 242900);
  assert.equal(row.contributions, 214761);
  assert.equal(1000000 - row.tax - row.contributions - 20000, 522339);
});

test('PPK anchor: maximum additional rates give 4 percent each without compounding employer benefits', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-extra-employee': '2', 'ppk-extra-employer': '2.5' });
  const row = app.payrollTimeline().pays[0];
  assert.equal(row.ownPension, 40000);
  assert.equal(row.employerIncome, 40000);
  assert.equal(row.tax, 75300);
  assert.equal(row.receivedTransfer, 669939);
});

test('PPK covers a linked bonus and assigns its net increment without treating the employer payment as cash', () => {
  const app = pensionSubject({ 'ppk-enabled': true });
  app.context.bonuses.push({ amount: 500000, date: '2026-01-29', link: 0, optional: false });
  const row = app.payrollTimeline().pays[0];
  assert.equal(row.ownPension, 30000);
  assert.equal(row.employerIncome, 22500);
  assert.equal(row.tax, 125000);
  assert.equal(row.contributions, 322142);
  assert.equal(row.receivedTransfer, 1022858);
  assert.equal(row.salary, 692939);
  assert.equal(row.bonusNet, 329919);
});

test('PPK covers independent bonus transfers using the shared monthly payroll state', () => {
  const app = pensionSubject({ 'ppk-enabled': true });
  app.context.bonuses.push({ amount: 500000, date: '2026-01-10', link: null, optional: false });
  const { pays, separate } = app.payrollTimeline();
  assert.equal(separate[0].ownPension, 10000);
  assert.equal(separate[0].employerIncome, 7500);
  assert.equal(pays[0].ownPension, 20000);
  assert.equal(pays[0].receivedTransfer + separate[0].amount, 1022858);
  assert.equal(pays[0].tax + separate[0].tax, 125000);
  assert.equal(pays[0].contributions + separate[0].contributions, 322142);
});

test('a later bonus subject to PPK cannot fund an earlier payday budget', () => {
  const app = pensionSubject({ 'ppk-enabled': true });
  app.context.bonuses.push({ amount: 500000, date: '2026-01-30', link: null, optional: false });
  const periods = app.collectPeriods(0, 0);
  assert.equal(periods[0].salary, 692939);
  assert.ok(periods[0].later > 0);
  assert.equal(app.simulate(periods, 700000, 0, 0, 'both').failure.shortfall, 7061);
});

test('PPK continues using the full gross basis after the annual pension cap', () => {
  const app = pensionSubject({ 'ppk-enabled': true });
  for (const pay of app.context.paychecks) pay.gross = 5000000;
  const rows = app.payrollTimeline().pays;
  for (const index of [0, 5, 11, 12, 18, 23]) {
    assert.equal(rows[index].ownPension, 100000);
    assert.equal(rows[index].employerIncome, 75000);
  }
});

test('next-month PPK separates current employee withholding from delayed employer PIT income', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-timing': 'next' });
  const { pays } = app.payrollTimeline();
  assert.equal(pays[0].employerIncome, 0);
  assert.equal(pays[0].ownPension, 20000);
  assert.equal(pays[0].receivedTransfer, 694739);
  assert.equal(pays[1].employerIncome, 15000);
  assert.equal(pays[1].receivedTransfer, 692939);
});

test('December employer PPK enters the next year and January gets only that delayed amount', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-timing': 'next' });
  app.context.paychecks[11].gross = 2000000;
  const { pays } = app.payrollTimeline();
  assert.equal(pays[11].employerIncome, 15000);
  assert.equal(pays[12].employerIncome, 30000);
  assert.equal(pays[12].incomeBefore, 0);
  assert.equal(pays[12].incomeAfter, 867900);
  assert.equal(pays[12].tax, 74100);
  assert.equal(pays[12].receivedTransfer, 691139);
});

test('a program active before 2026 requires an explicit opening employer payment when delayed', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-start': '-1', 'ppk-timing': 'next' });
  assert.equal(app.pensionInputError().key, 'ppk-opening');
  assert.match(app.calculatePlan().error, /2025/);
  app.context.config['ppk-opening'].value = '0';
  assert.equal(app.pensionInputError(), null);
  assert.equal(app.payrollTimeline().pays[0].employerIncome, 0);
  app.context.config['ppk-opening'].value = '150';
  const row = app.collectPeriods(0, 0)[0];
  assert.equal(row.employerIncome, 15000);
  assert.equal(row.received, 692939);
  assert.equal(app.simulate([row], 692940, 0, 0, 'both').failure.shortfall, 1);
});

test('December 2027 employer payments scheduled for 2028 are disclosed without entering 2027 PIT', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-timing': 'next' });
  app.context.paychecks[23].gross = 2000000;
  const timeline = app.payrollTimeline();
  assert.equal(timeline.pensionAfter2027, 30000);
  assert.equal(timeline.pays[23].employerIncome, 15000);
});

test('a month without cash records employer PIT income and unpaid tax without inventing a negative transfer', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-start': '-1', 'ppk-timing': 'next', 'ppk-opening': '10000' });
  app.context.paychecks[0].date = '2026-02-02';
  const timeline = app.payrollTimeline();
  assert.equal(timeline.separate.length, 0);
  assert.equal(timeline.uncollected[0].month, '2026-01');
  assert.equal(timeline.uncollected[0].tax, 87000);
  assert.equal(timeline.pays[0].incomeBefore, 975000);
  assert.ok(timeline.pays[0].receivedTransfer > 0);
});

test('PPE anchor: 250 employee plus 7 percent employer gives 6,813.39 net on 10,000 gross', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer': '7' });
  const row = app.payrollTimeline().pays[0];
  assert.equal(row.ownPension, 25000);
  assert.equal(row.employerIncome, 70000);
  assert.equal(row.tax, 78900);
  assert.equal(row.contributions, 214761);
  assert.equal(row.receivedTransfer, 681339);
});

test('PPE fixed amounts apply once a calendar month even with several salary transfers', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer-unit': 'amount', 'ppe-employer': '700' });
  app.context.paychecks[1].date = '2026-01-30';
  const timeline = app.payrollTimeline();
  assert.equal(timeline.pays[0].ownPension + timeline.pays[1].ownPension, 25000);
  assert.equal(timeline.pays[0].employerIncome + timeline.pays[1].employerIncome, 70000);
});

test('fixed PPE remains on salary when an independent bonus precedes it', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer-unit': 'amount', 'ppe-employer': '700' });
  app.context.bonuses.push({ amount: 500000, date: '2026-01-10', link: null, optional: false });
  const timeline = app.payrollTimeline();
  assert.equal(timeline.separate[0].ownPension, 0);
  assert.equal(timeline.separate[0].employerIncome, 0);
  assert.equal(timeline.pays[0].ownPension, 25000);
  assert.equal(timeline.pays[0].employerIncome, 70000);
  assert.equal(timeline.pays[0].receivedTransfer + timeline.separate[0].amount, 1022158);
});

test('PPE employee annual limits stop withholding and reset separately for each year', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employee': '4000', 'ppe-employer': '7' });
  const rows = app.payrollTimeline().pays;
  assert.equal(rows[10].ownPension, 239000);
  assert.equal(rows[11].ownPension, 0);
  assert.equal(rows[12].ownPension, 400000);
  assert.equal(rows[23].ownPension, 114850);
  assert.equal(rows.slice(0, 12).reduce((sum, row) => sum + row.ownPension, 0), 4239000);
  assert.equal(rows.slice(12).reduce((sum, row) => sum + row.ownPension, 0), 4514850);
});

test('percentage PPE covers both salary and bonuses, including after the pension cap', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employee-unit': 'percent', 'ppe-employee': '1', 'ppe-employer': '7' });
  for (const pay of app.context.paychecks) pay.gross = 5000000;
  app.context.bonuses.push({ amount: 500000, date: '2026-12-10', link: null, optional: false });
  const timeline = app.payrollTimeline();
  assert.equal(timeline.pays[11].ownPension, 50000);
  assert.equal(timeline.pays[11].employerIncome, 350000);
  assert.equal(timeline.separate[0].ownPension, 5000);
  assert.equal(timeline.separate[0].employerIncome, 35000);
});

test('PPK and PPE coexist and combine only their tax income and employee withholding', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer': '7' });
  const row = app.payrollTimeline().pays[0];
  assert.equal(row.ownPension, 45000);
  assert.equal(row.employerIncome, 85000);
  assert.equal(row.tax, 80700);
  assert.equal(row.contributions, 214761);
  assert.equal(row.receivedTransfer, 659539);
});

test('legacy PPK and PPE deductions are replaced once and return when a module is disabled', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer': '7' });
  app.context.ui = { 'kzp-summary': {} };
  app.context.deductions.push(
    { kind: 'PPK pracownika', name: 'PPK pracownika', amount: 20000, percent: false, start: 0, end: 23, interval: 1 },
    { kind: 'PPE pracownika', name: 'PPE pracownika', amount: 25000, percent: false, start: 0, end: 23, interval: 1 },
  );
  vm.runInContext(pageFunction('workplaceDeductions'), app.context);
  assert.equal(app.payrollTimeline().pays[0].withheld, 45000);
  assert.equal(app.payrollTimeline().pays[0].receivedTransfer, 659539);
  app.context.config['ppk-enabled'].checked = false;
  app.context.config['ppe-enabled'].checked = false;
  assert.equal(app.payrollTimeline().pays[0].withheld, 45000);
  assert.equal(app.context.deductions.length, 2);
});

test('legacy deductions before the new module starts remain effective', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppk-start': '6' });
  app.context.ui = { 'kzp-summary': {} };
  app.context.deductions.push({ kind: 'PPK pracownika', name: 'PPK pracownika', amount: 20000, percent: false, start: 0, end: 23, interval: 1 });
  vm.runInContext(pageFunction('workplaceDeductions'), app.context);
  const rows = app.payrollTimeline().pays;
  assert.equal(rows[0].ownPension, 0);
  assert.equal(rows[0].withheld, 20000);
  assert.equal(rows[6].ownPension, 20000);
  assert.equal(rows[6].withheld, 20000);
});

test('an entered real transfer is never reduced a second time by program contributions', () => {
  const app = pensionSubject({ 'ppk-enabled': true, 'ppe-enabled': true, 'ppe-employee': '250', 'ppe-employer': '7' });
  app.context.paychecks[0].enteredNet = 654321;
  assert.equal(app.payrollTimeline().pays[0].receivedTransfer, 654321);
  assert.equal(app.collectPeriods(0, 0)[0].received, 654321);
});

for (const preset of ['current', 'draft3293']) {
  test('2027 employer program income uses the selected PIT scale: ' + preset, () => {
    const app = pensionSubject({ 'ppk-enabled': true });
    app.context.config['tax-2027'].value = preset;
    const row = app.monthPayroll(1000000, 12500000, 0, 2027, 15000);
    assert.equal(row.contributions, 214761);
    assert.equal(row.tax, preset === 'current' ? 242900 : 114700);
  });
}

test('program validation identifies missing employer PPE and invalid additional rates', () => {
  const app = pensionSubject({ 'ppe-enabled': true });
  assert.equal(app.pensionInputError().key, 'ppe-employer');
  assert.equal(app.calculatePlan().periods[0].received, null);
  app.context.config['ppe-employer'].value = '7.01';
  assert.equal(app.pensionInputError().key, 'ppe-employer');
  app.context.config['ppe-enabled'].checked = false;
  app.context.config['ppk-enabled'].checked = true;
  app.context.config['ppk-extra-employee'].value = '2.01';
  assert.equal(app.pensionInputError().key, 'ppk-extra-employee');
  app.context.config['ppk-extra-employee'].value = '0';
  app.context.config['ppk-extra-employer'].value = '2.51';
  assert.equal(app.pensionInputError().key, 'ppk-extra-employer');
});

test('fixed employer PPE above 7 percent of the monthly basis is rejected', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employer-unit': 'amount', 'ppe-employer': '701' });
  assert.match(app.calculatePlan().error, /przekracza 7%/);
});

test('fixed employer PPE reports the first invalid calendar month using a Polish month name', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-employer-unit': 'amount', 'ppe-employer': '701' });
  for (let index = 0; index < 5; index++) app.context.paychecks[index].gross = 1100000;
  const message = app.calculatePlan().error;
  assert.match(message, /Pierwszy miesiąc: czerwiec 2026\./);
  assert.doesNotMatch(message, /2027-12|grudzień 2027/);
});

test('PPE validation uses the actual payment month after a salary date correction', () => {
  const app = pensionSubject({ 'ppe-enabled': true, 'ppe-start': '0', 'ppe-end': '0', 'ppe-employer-unit': 'amount', 'ppe-employer': '701' });
  app.context.paychecks[1].date = '2026-01-30';
  assert.equal(app.payrollTimeline().pensionIssue, null);
  app.context.paychecks[1].date = '2026-02-26';
  assert.match(app.payrollTimeline().pensionIssue.message, /Pierwszy miesiąc: styczeń 2026\./);
});

test('old 0.6.1 plans without program fields keep all data and leave both modules disabled', () => {
  const app = storageSubject();
  app.savePlan();
  const legacy = JSON.parse([...app.storage.values()][0]);
  for (const key of Object.keys(app.context.subject.pensionDefaults)) delete legacy.config[key];
  app.storage.set('kalkulator-wyplat.plan.v1', JSON.stringify(legacy));
  const restored = storageSubject(app.storage, false, false);
  restored.loadPlan();
  assert.match(restored.context.ui['storage-status'].textContent, /Odtworzono/);
  assert.equal(restored.context.config['ppk-enabled'].checked, false);
  assert.equal(restored.context.config['ppe-enabled'].checked, false);
  assert.equal(restored.context.config['ppk-start'].value, '-1');
  assert.equal(restored.context.config['ppe-start'].value, '-1');
  assert.equal(restored.context.paychecks[0].gross, 1450000);
});

for (const kind of ['ppk', 'ppe']) {
  test('new and migrated plans both require the prior-year opening payment for delayed ' + kind.toUpperCase(), () => {
    const fresh = pensionSubject({ [kind + '-enabled']: true, [kind + '-timing']: 'next', 'ppe-employer': '7' });
    assert.equal(fresh.pensionInputError()?.key, kind + '-opening');
    fresh.context.config[kind + '-opening'].value = '0';
    assert.equal(fresh.pensionInputError(), null);
    const withoutOpening = fresh.payrollTimeline().pays[0].receivedTransfer;
    fresh.context.config[kind + '-opening'].value = kind === 'ppk' ? '150' : '700';
    assert.equal(withoutOpening - fresh.payrollTimeline().pays[0].receivedTransfer, kind === 'ppk' ? 1800 : 8400);
    const app = storageSubject();
    app.savePlan();
    const legacy = JSON.parse([...app.storage.values()][0]);
    for (const key of Object.keys(app.context.subject.pensionDefaults)) delete legacy.config[key];
    app.storage.set('kalkulator-wyplat.plan.v1', JSON.stringify(legacy));
    const restored = storageSubject(app.storage, false, false);
    restored.loadPlan();
    restored.context.config[kind + '-enabled'].checked = true;
    restored.context.config[kind + '-timing'].value = 'next';
    restored.context.config['ppe-employer'].value = '7';
    assert.equal(restored.context.subject.pensionInputError()?.key, kind + '-opening');
    restored.context.config[kind + '-opening'].value = '0';
    assert.equal(restored.context.subject.pensionInputError(), null);
    restored.context.config[kind + '-opening'].value = kind === 'ppk' ? '150' : '700';
    assert.equal(restored.context.subject.pensionInputError(), null);
  });
}

test('an explicit January 2026 program start survives reload and does not require a 2025 payment', () => {
  const app = storageSubject();
  for (const kind of ['ppk', 'ppe']) {
    app.context.config[kind + '-enabled'].checked = true;
    app.context.config[kind + '-start'].value = '0';
    app.context.config[kind + '-timing'].value = 'next';
  }
  app.context.config['ppe-employer'].value = '7';
  assert.equal(app.context.subject.pensionInputError(), null);
  app.savePlan();
  const restored = storageSubject(app.storage, false, false);
  restored.loadPlan();
  for (const kind of ['ppk', 'ppe']) {
    assert.equal(restored.context.config[kind + '-start'].value, '0');
    assert.equal(restored.context.config[kind + '-opening'].value, '');
  }
  assert.equal(restored.context.subject.pensionInputError(), null);
});

test('program settings, timing and opening payments survive saved plan restoration', () => {
  const app = storageSubject();
  app.context.config['ppk-enabled'].checked = true;
  app.context.config['ppk-start'].value = '-1';
  app.context.config['ppk-timing'].value = 'next';
  app.context.config['ppk-opening'].value = '150';
  app.context.config['ppk-extra-employee'].value = '2';
  app.context.config['ppk-extra-employer'].value = '2.5';
  app.context.config['ppe-enabled'].checked = true;
  app.context.config['ppe-employee'].value = '250';
  app.context.config['ppe-employer'].value = '7';
  app.savePlan();
  const restored = storageSubject(app.storage, false, false);
  restored.loadPlan();
  assert.equal(JSON.stringify(restored.storedPlan()), JSON.stringify(app.storedPlan()));
});
