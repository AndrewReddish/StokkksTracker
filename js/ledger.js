// Replays every statement event day by day: cash per currency, FIFO lots per
// security, dividends and costs. Produces the daily NAV / net-deposit series and
// per-position analytics used by the dashboard.

const DAY = 864e5;
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const isWeekday = d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = key(x); (m.get(k) || m.set(k, []).get(k)).push(x); }
  return m;
}

// Converts each deposit into base currency at that day's observed FX rate, then scales
// per statement so the total equals IBKR's own "Total in <base>" figure. The scale
// factor (and any deposit with no observed rate) is reported on the Data status page.
function depositsInBase(model, book, warnings, fxNotes) {
  const out = model.deposits.map(d => ({ ...d, base: d.amount * book.fx(d.ccy)(d.date) }));
  for (const s of model.statements) {
    for (const [ccy, tot] of Object.entries(s.depositTotals || {})) {
      if (ccy === model.baseCcy || !isFinite(tot.base)) continue;
      const inPeriod = out.filter(d => d.ccy === ccy && d.date >= s.periodStart && d.date <= s.periodEnd);
      const missing = inPeriod.filter(d => !isFinite(d.base));
      if (missing.length) {
        // No observed rate: fall back to IBKR's own period total, spread by amount.
        for (const d of inPeriod) d.base = d.amount * tot.base / tot.native;
        warnings.push({ level: 'warn', area: 'FX', text: `No ${ccy}/${model.baseCcy} rate for ${missing.length} deposit(s) in ${s.periodStart} – ${s.periodEnd}; those deposits use IBKR's period total divided by the ${ccy} amount.` });
        fxNotes.push({ ccy, period: `${s.periodStart} – ${s.periodEnd}`, native: tot.native, base: tot.base, scale: null });
        continue;
      }
      const sum = inPeriod.reduce((a, d) => a + d.base, 0);
      if (sum) for (const d of inPeriod) d.base *= tot.base / sum;
      fxNotes.push({ ccy, period: `${s.periodStart} – ${s.periodEnd}`, native: tot.native, base: tot.base, scale: sum ? tot.base / sum : null });
    }
  }
  return out;
}

export function runLedger(model, book, { endDate } = {}) {
  const base = model.baseCcy;
  const warnings = [], fxNotes = [], unpriced = new Map();
  const deposits = depositsInBase(model, book, warnings, fxNotes);
  const first = model.statements[0];

  // Events keyed by date.
  const ev = new Map();
  const push = (date, e) => (ev.get(date) || ev.set(date, []).get(date)).push(e);
  deposits.forEach(d => push(d.date, { type: 'deposit', d }));
  model.trades.forEach(t => push(t.date, { type: 'trade', t }));
  model.dividends.forEach(d => push(d.date, { type: 'dividend', d }));
  model.withholding.forEach(d => push(d.date, { type: 'tax', d }));
  model.interest.forEach(d => push(d.date, { type: 'interest', d }));
  model.fees.forEach(d => push(d.date, { type: 'fee', d }));
  model.corporateActions.forEach(c => push(c.date, { type: 'corp', c }));

  const cash = { [base]: 0 };
  const lots = {};       // sym -> [{qty, cost}] cost per share incl. commission
  const pos = {};        // sym -> analytics accumulator
  const P = sym => (pos[sym] ||= {
    symbol: sym, trades: [], realized: 0, realizedOwn: 0, dividends: 0, tax: 0, commissions: 0,
    bought: 0, sold: 0, flows: [], firstDate: null, lastDate: null,
  });
  const qtyOf = sym => (lots[sym] || []).reduce((a, l) => a + l.qty, 0);
  const costOf = sym => (lots[sym] || []).reduce((a, l) => a + l.qty * l.cost, 0);
  const totals = { commissions: 0, fxCommissions: 0, dividends: 0, tax: 0, interest: 0, fees: 0 };

  let startDate = model.periodStart;
  let opening = 0;
  // A statement that does not start at account opening: seed from its prior marks.
  if (isFinite(first.nav.start) && first.nav.start > 0.01) {
    for (const m of model.mtm.filter(m => m.periodStart === first.periodStart && m.priorQty)) {
      lots[m.symbol] = [{ qty: m.priorQty, cost: m.priorPrice }];
      P(m.symbol).bought += m.priorQty * m.priorPrice;
      P(m.symbol).flows.push({ date: addDays(startDate, -1), amount: -m.priorQty * m.priorPrice });
      P(m.symbol).firstDate = addDays(startDate, -1);
    }
    cash[base] = isFinite(first.cash['Starting Cash']) ? first.cash['Starting Cash'] : 0;
    opening = first.nav.start;
    warnings.push({ level: 'warn', area: 'History', text: `The earliest statement starts on ${first.periodStart} with ${Math.round(first.nav.start)} ${base} already in the account. Add the statements before it for exact cost basis; until then, positions held on that date use that day's close as their cost, and the opening value counts as the first deposit.` });
  }

  const lastDate = endDate || model.periodEnd;
  const series = { dates: [], nav: [], netDeposits: [], flow: [], cash: [], invested: [], cost: [], holdings: [], qty: [], costs: [] };
  let netDeposits = opening, pendingFlow = opening;
  const flowsXirr = opening ? [{ date: addDays(startDate, -1), amount: -opening }] : [];

  for (let d = startDate; d <= lastDate; d = addDays(d, 1)) {
    for (const e of ev.get(d) || []) {
      switch (e.type) {
        case 'deposit': {
          const { d: dep } = e;
          cash[dep.ccy] = (cash[dep.ccy] || 0) + dep.amount;
          netDeposits += dep.base; pendingFlow += dep.base;
          flowsXirr.push({ date: d, amount: -dep.base });
          break;
        }
        case 'trade': {
          const t = e.t;
          if (t.kind === 'forex') {
            const [b, q] = t.symbol.split('.');
            cash[b] = (cash[b] || 0) + t.qty;
            cash[q] = (cash[q] || 0) + t.proceeds;
            cash[t.commCcy] = (cash[t.commCcy] || 0) + t.comm;
            totals.fxCommissions += t.comm * book.fx(t.commCcy)(d);
            break;
          }
          const fx = book.fx(t.ccy)(d);
          cash[t.ccy] = (cash[t.ccy] || 0) + t.proceeds + t.comm;
          totals.commissions += t.comm * fx;
          const p = P(t.symbol);
          p.commissions += t.comm * fx;
          p.firstDate ||= d; p.lastDate = d;
          p.flows.push({ date: d, amount: (t.proceeds + t.comm) * fx });
          const L = (lots[t.symbol] ||= []);
          let own = 0;
          if (t.qty > 0) {
            L.push({ qty: t.qty, cost: -(t.proceeds + t.comm) / t.qty, date: d });
            p.bought += -(t.proceeds + t.comm) * fx;
          } else {
            let left = -t.qty, basis = 0;
            while (left > 1e-9 && L.length) {
              const l = L[0], take = Math.min(left, l.qty);
              basis += take * l.cost; l.qty -= take; left -= take;
              if (l.qty <= 1e-9) L.shift();
            }
            own = (t.proceeds + t.comm - basis) * fx;
            // IBKR may match lots differently from FIFO; keep the remaining cost
            // basis consistent with the broker's own Basis column.
            const ibkrBasis = -t.basis;
            const rem = L.reduce((a, l) => a + l.qty, 0);
            if (isFinite(ibkrBasis) && ibkrBasis > 0 && rem > 1e-9) {
              const adj = (basis - ibkrBasis) / rem;
              L.forEach(l => { l.cost += adj; });
            }
            p.sold += (t.proceeds + t.comm) * fx;
          }
          const realized = isFinite(t.realized) && t.realized !== 0 ? t.realized * fx : own;
          p.realized += realized; p.realizedOwn += own;
          const q = qtyOf(t.symbol);
          p.trades.push({ ...t, side: t.qty > 0 ? 'BUY' : 'SELL', amount: Math.abs(t.proceeds) * fx, realizedBase: t.qty < 0 ? realized : 0, qtyAfter: q, avgCostAfter: q > 1e-9 ? costOf(t.symbol) / q : NaN });
          break;
        }
        case 'dividend': case 'tax': case 'interest': case 'fee': {
          const x = e.d, fx = book.fx(x.ccy)(d), v = x.amount * fx;
          cash[x.ccy] = (cash[x.ccy] || 0) + x.amount;
          const key = { dividend: 'dividends', tax: 'tax', interest: 'interest', fee: 'fees' }[e.type];
          totals[key] += v;
          if ((e.type === 'dividend' || e.type === 'tax') && x.symbol) {
            const p = P(x.symbol);
            p[e.type === 'dividend' ? 'dividends' : 'tax'] += v;
            p.flows.push({ date: d, amount: v });
          }
          break;
        }
        case 'corp': {
          const c = e.c;
          if (!c.symbol || !isFinite(c.qty)) break;
          const L = (lots[c.symbol] ||= []);
          const before = qtyOf(c.symbol);
          if (/split/i.test(c.desc) && before > 0) {
            const k = (before + c.qty) / before;
            L.forEach(l => { l.qty *= k; l.cost /= k; });
          } else if (c.qty > 0) L.push({ qty: c.qty, cost: 0, date: d });
          cash[c.ccy || base] = (cash[c.ccy || base] || 0) + (c.proceeds || 0);
          break;
        }
      }
    }
    if (!isWeekday(d) && d !== lastDate) continue;
    // Mark to market.
    let invested = 0, cost = 0;
    const holdings = {}, qtys = {}, costs = {};
    for (const sym of Object.keys(lots)) {
      const q = qtyOf(sym);
      if (Math.abs(q) < 1e-9) continue;
      const px = book[sym] ? book[sym].at(d) : NaN;
      if (!isFinite(px) && !unpriced.has(sym)) unpriced.set(sym, d);
      const v = isFinite(px) ? q * px : 0; // no observed price: not valued (reported on Data status)
      holdings[sym] = v; qtys[sym] = q; costs[sym] = costOf(sym); invested += v; cost += costs[sym];
    }
    let cashBase = 0;
    for (const [ccy, amt] of Object.entries(cash)) {
      const r = book.fx(ccy)(d);
      if (isFinite(r)) cashBase += amt * r;
      else if (Math.abs(amt) > 0.005 && !unpriced.has('cash:' + ccy)) unpriced.set('cash:' + ccy, d);
    }
    series.dates.push(d);
    series.nav.push(invested + cashBase);
    series.netDeposits.push(netDeposits);
    series.flow.push(pendingFlow); pendingFlow = 0;
    series.cash.push(cashBase);
    series.invested.push(invested);
    series.cost.push(cost);
    series.holdings.push(holdings);
    series.qty.push(qtys);
    series.costs.push(costs);
  }

  // Final per-position snapshot.
  const end = series.dates.at(-1);
  const positions = Object.values(pos).map(p => {
    const qty = qtyOf(p.symbol);
    const open = Math.abs(qty) > 1e-9;
    const px = book[p.symbol] ? book[p.symbol].at(end) : NaN;
    const value = open ? qty * px : 0;
    // Prefer the broker's own cost basis when the latest statement ends on the last day.
    const ibkr = model.openPositions.find(o => o.symbol === p.symbol);
    const useIbkr = open && ibkr && model.latest.periodEnd === end && Math.abs(ibkr.qty - qty) < 1e-6 && isFinite(ibkr.costBasis);
    const costBasis = open ? (useIbkr ? ibkr.costBasis * book.fx(ibkr.ccy)(end) : costOf(p.symbol)) : 0;
    const unrealized = value - costBasis;
    const income = p.dividends + p.tax;
    const total = p.realized + unrealized + income;
    const flows = [...p.flows];
    if (open) flows.push({ date: end, amount: value });
    const inst = model.instruments[p.symbol] || {};
    return {
      ...p, qty, open, price: px, value, costBasis, avgCost: open ? costBasis / qty : NaN, unrealized, income, total,
      returnOnCapital: p.bought ? total / p.bought : NaN,
      irr: xirr(flows),
      name: inst.name || p.symbol, type: inst.type || '', priceSource: book[p.symbol]?.source || 'none',
      holdingDays: p.firstDate ? Math.round((Date.parse((open ? end : p.lastDate) + 'T00:00:00Z') - Date.parse(p.firstDate + 'T00:00:00Z')) / DAY) : 0,
    };
  }).sort((a, b) => b.value - a.value || b.total - a.total);

  for (const [sym, d] of unpriced) warnings.push({ level: 'error', area: 'Prices', text: sym.startsWith('cash:') ? `${sym.slice(5)} cash has no exchange rate from ${d}; it is left out of the portfolio value.` : `${sym} has no observed price from ${d}; it is left out of the portfolio value until one exists.` });
  return { series, positions, deposits, totals, flowsXirr, cashByCcy: cash, startDate, endDate: end, warnings, fxNotes };
}

// Money-weighted return: annualised IRR of dated cash flows (negative = money in).
export function xirr(flows) {
  const f = flows.filter(x => isFinite(x.amount) && Math.abs(x.amount) > 1e-9);
  if (f.length < 2 || !f.some(x => x.amount > 0) || !f.some(x => x.amount < 0)) return NaN;
  const t0 = Date.parse(f[0].date + 'T00:00:00Z');
  const ts = f.map(x => (Date.parse(x.date + 'T00:00:00Z') - t0) / (365 * DAY));
  const npv = r => f.reduce((a, x, i) => a + x.amount / Math.pow(1 + r, ts[i]), 0);
  let lo = -0.9999, hi = 1000;
  let flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export { groupBy };
