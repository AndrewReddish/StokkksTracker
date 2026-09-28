// Costs paid outside the IBKR account, entered by the user: the bank's commission on
// each incoming transfer (only visible in the banking app) and income tax paid for a
// closed tax year (on realized gains and dividends). They are not in the statements,
// so they are applied on top of the ledger: see computeKPIs in metrics.js.

export const DEFAULT_COST_SETTINGS = { depositPct: 0, depositOverrides: {}, taxRate: 15, taxPaid: {} };

export const depositKey = d => `${d.date}|${d.ccy}|${d.amount}`;
const num = v => v === '' || v === null || v === undefined ? NaN : +v;

export function normalizeCostSettings(s) {
  const x = { ...DEFAULT_COST_SETTINGS, ...(s || {}) };
  return { depositPct: isFinite(num(x.depositPct)) ? +x.depositPct : 0, depositOverrides: { ...(x.depositOverrides || {}) },
    taxRate: isFinite(num(x.taxRate)) ? +x.taxRate : DEFAULT_COST_SETTINGS.taxRate, taxPaid: { ...(x.taxPaid || {}) } };
}

// Incoming transfers with the commission rate that applies to each (per-deposit
// override, else the default rate). Withdrawals carry no commission.
export function depositFees(ledger, settings) {
  return ledger.deposits.filter(d => d.amount > 0 && isFinite(d.base)).map(d => {
    const key = depositKey(d);
    const override = num(settings.depositOverrides[key]);
    const pct = isFinite(override) ? override : settings.depositPct;
    return { key, date: d.date, ccy: d.ccy, amount: d.amount, base: d.base, pct, overridden: isFinite(override), fee: d.base * pct / 100 };
  });
}

// Completed calendar years in the data (the tax year has ended by the last day).
export function taxYears(ledger) {
  const first = +ledger.startDate.slice(0, 4), last = +ledger.endDate.slice(0, 4);
  const out = [];
  const lastDone = ledger.endDate >= `${last}-12-31` ? last : last - 1; // an annual statement ends on 31 December
  for (let y = first; y <= lastDone; y++) out.push(String(y));
  return out;
}

// Per tax year: net realized gain on sales, gross dividends and tax already withheld by
// IBKR, an estimate at the chosen rate (withholding credited, never below zero), and
// the amount actually used (the user's figure when entered, otherwise the estimate).
export function taxByYear(model, ledger, book, settings) {
  return taxYears(ledger).map(year => {
    const inYear = d => d.startsWith(year);
    const realized = ledger.positions.flatMap(p => p.trades).filter(t => t.side === 'SELL' && inYear(t.date)).reduce((a, t) => a + t.realizedBase, 0);
    const base = x => x.amount * book.fx(x.ccy)(x.date);
    const dividends = model.dividends.filter(x => inYear(x.date)).reduce((a, x) => a + base(x), 0);
    const withheld = model.withholding.filter(x => inYear(x.date)).reduce((a, x) => a + base(x), 0); // negative
    const rate = settings.taxRate / 100;
    const estimate = Math.max(0, Math.max(0, realized) * rate + Math.max(0, dividends) * rate + withheld);
    const entered = num(settings.taxPaid[year]);
    return { year, realized, dividends, withheld, estimate, entered, paid: isFinite(entered) ? entered : estimate, isEstimate: !isFinite(entered) };
  });
}

// Dated cost events for computeKPIs. Tax is booked on the last day of its tax year.
export function outsideCosts(model, ledger, book, settings) {
  const s = normalizeCostSettings(settings);
  const deposits = depositFees(ledger, s);
  const tax = taxByYear(model, ledger, book, s);
  const events = [
    ...deposits.filter(d => d.fee > 0).map(d => ({ date: d.date, amount: d.fee, kind: 'deposit' })),
    ...tax.filter(t => t.paid > 0).map(t => ({ date: `${t.year}-12-31`, amount: t.paid, kind: 'tax' })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return { settings: s, deposits, tax, events };
}
