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
    goals: [{ checked: true, value: 'maximum' }],
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
  const constants = ['amountFormat', 'inZloty', 'money', 'pensionLimits', 'roundRate', 'wholeZloty'];
  const declarations = constants.map(name => {
    const match = source.match(new RegExp('^      const ' + name + ' = .+;$', 'm'));
    assert.ok(match, 'Missing constant ' + name);
    return match[0];
  });
  const functions = ['defaultPayDate', 'progressiveTax', 'monthPayroll', 'payrollTimeline', 'collectPeriods', 'simulate', 'calculatePlan', 'failureMessage'];
  const code = [...declarations, ...functions.map(pageFunction), 'globalThis.subject = { ' + functions.join(', ') + ', money };'].join('\n');
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
