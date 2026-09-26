// Portfolio-level statistics derived from the ledger's daily series.
import { xirr } from './ledger.js';

// Time-weighted return index: external flows are assumed to arrive at the start of the day.
export function twrIndex(series) {
  const idx = [];
  let I = 1, prev = 0;
  for (let i = 0; i < series.dates.length; i++) {
    const nav = series.nav[i], denom = prev + series.flow[i];
    if (denom > 1 && prev > 1) I *= nav / denom;
    else if (denom > 1 && prev <= 1) I *= nav / denom; // first funded day
    idx.push(I);
    prev = nav;
  }
  return idx;
}

export function drawdown(index) {
  let peak = -Infinity, maxDD = 0, peakAt = 0, troughAt = 0, curPeakAt = 0;
  const dd = index.map((v, i) => {
    if (v > peak) { peak = v; curPeakAt = i; }
    const x = v / peak - 1;
    if (x < maxDD) { maxDD = x; peakAt = curPeakAt; troughAt = i; }
    return x;
  });
  return { dd, maxDD, peakAt, troughAt };
}

export function periodReturns(dates, index, keyLen = 7) {
  // keyLen 7 -> monthly (YYYY-MM), 4 -> yearly.
  const out = [];
  let prevEnd = 1, curKey = null, lastVal = 1;
  for (let i = 0; i < dates.length; i++) {
    const k = dates[i].slice(0, keyLen);
    if (curKey && k !== curKey) { out.push({ period: curKey, ret: lastVal / prevEnd - 1 }); prevEnd = lastVal; }
    curKey = k; lastVal = index[i];
  }
  if (curKey) out.push({ period: curKey, ret: lastVal / prevEnd - 1 });
  return out;
}

// "What if every deposit had bought this benchmark instead?"
export function benchmarkSameFlows(series, priceAt) {
  let units = 0;
  const value = [];
  for (let i = 0; i < series.dates.length; i++) {
    const px = priceAt(series.dates[i]);
    if (series.flow[i] && isFinite(px) && px > 0) units += series.flow[i] / px;
    value.push(units * px);
  }
  return value;
}

export function priceIndex(series, priceAt, startIdx = 0) {
  const p0 = priceAt(series.dates[startIdx]);
  return series.dates.map(d => priceAt(d) / p0);
}

export function computeKPIs(model, ledger) {
  const s = ledger.series;
  const n = s.dates.length - 1;
  const index = twrIndex(s);
  const { dd, maxDD, peakAt, troughAt } = drawdown(index);
  const nav = s.nav[n], dep = s.netDeposits[n];
  const flows = [...ledger.flowsXirr, { date: s.dates[n], amount: nav }];
  const years = (Date.parse(s.dates[n]) - Date.parse(s.dates[0])) / (365 * 864e5);
  const open = ledger.positions.filter(p => p.open);
  const closed = ledger.positions.filter(p => !p.open);
  const sells = ledger.positions.flatMap(p => p.trades.filter(t => t.side === 'SELL'));
  const wins = sells.filter(t => t.realizedBase > 0).length;

  // Reconciliation against IBKR's own ending NAV for each statement.
  const recon = model.statements.map(st => {
    let i = s.dates.findIndex(d => d > st.periodEnd) - 1;
    if (i < 0) i = n;
    const computed = s.nav[i];
    return { period: `${st.periodStart} → ${st.periodEnd}`, statementNav: st.nav.end, accruals: st.accruals || 0, computed, diff: computed - (st.nav.end - (st.accruals || 0)), ibkrTwr: st.nav.twr };
  });
  const ibkrTwrChain = model.statements.reduce((a, st) => a * (1 + (isFinite(st.nav.twr) ? st.nav.twr : 0)), 1) - 1;

  return {
    nav, netDeposits: dep, gain: nav - dep, gainPct: dep ? (nav - dep) / dep : NaN,
    twr: index[n] - 1, twrAnnual: years > 1 ? Math.pow(index[n], 1 / years) - 1 : NaN, ibkrTwrChain,
    xirr: xirr(flows), maxDD, ddPeak: s.dates[peakAt], ddTrough: s.dates[troughAt],
    realized: ledger.positions.reduce((a, p) => a + p.realized, 0),
    unrealized: open.reduce((a, p) => a + p.unrealized, 0),
    dividends: ledger.totals.dividends, tax: ledger.totals.tax, interest: ledger.totals.interest, fees: ledger.totals.fees,
    commissions: ledger.totals.commissions + ledger.totals.fxCommissions,
    cash: s.cash[n], invested: s.invested[n], openCount: open.length, closedCount: closed.length,
    tradeCount: ledger.positions.reduce((a, p) => a + p.trades.length, 0),
    winRate: sells.length ? wins / sells.length : NaN, sellCount: sells.length,
    index, dd, recon, years,
  };
}
