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
  const constants = ['amountFormat', 'numberFormat', 'inZloty', 'formatPercent', 'money', 'isoDate', 'pensionLimits', 'roundRate', 'wholeZloty'];
  const declarations = constants.map(name => {
    const match = source.match(new RegExp('^      const ' + name + ' = .+;$', 'm'));
    assert.ok(match, 'Missing constant ' + name);
    return match[0];
  });
  const functions = ['defaultPayDate', 'planStartDate', 'kzpInputError', 'progressiveTax', 'monthPayroll', 'payrollTimeline', 'collectPeriods', 'simulate', 'calculatePlan', 'failureMessage'];
  const code = [...declarations, ...functions.map(pageFunction), 'globalThis.subject = { ' + functions.join(', ') + ', money, formatPercent };'].join('\n');
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
