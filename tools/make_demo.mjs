// Generates demo/demo-statement-2026.csv: a fictional IBKR Activity Statement
// for a made-up account, built from real daily closes in data/prices/.
// Deterministic (seeded), so re-running produces the same file for the same cache.
// Usage: node tools/make_demo.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFiles, analyze, neededSymbols } from '../js/engine.js';
import { cacheFileName } from '../js/prices.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'demo', 'demo-statement-2026.csv');
const YEAR = '2026';

/* ---------- deterministic randomness ---------- */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260101);
const between = (a, b) => a + (b - a) * rnd();
const pick = arr => arr[Math.floor(rnd() * arr.length)];

/* ---------- prices ---------- */
const load = sym => JSON.parse(fs.readFileSync(path.join(root, 'data/prices', cacheFileName(sym)), 'utf8'));
const series = {};
const closeOn = (sym, d) => {
  const s = (series[sym] ||= load(sym));
  let lo = 0, hi = s.dates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) lo = m + 1; else hi = m; }
  return s.close[Math.max(0, lo - 1)];
};
const days = load('SPY').dates.filter(d => d.startsWith(YEAR));
const lastDay = days.at(-1);
const nextDay = (d, n = 1) => days[Math.min(days.length - 1, days.indexOf(d) + n)];
const dayOnOrAfter = d => days.find(x => x >= d) || lastDay;

const INSTRUMENTS = {
  SCHD: ['SCHWAB US DVD EQUITY ETF', '96079912', 'US8085247976', 'ARCA', 'ETF'],
  VXUS: ['VANGUARD TOTAL INTL STOCK', '83512168', 'US9219097683', 'NASDAQ', 'ETF'],
  AVUV: ['AVANTIS US SMALL CAP VALUE', '385087149', 'US0250728773', 'ARCA', 'ETF'],
  QQQ: ['INVESCO QQQ TRUST SERIES 1', '320227571', 'US46090E1038', 'NASDAQ', 'ETF'],
  V: ['VISA INC-CLASS A SHARES', '49462172', 'US92826C8394', 'NYSE', 'COMMON'],
  MSFT: ['MICROSOFT CORP', '272093', 'US5949181045', 'NASDAQ', 'COMMON'],
  O: ['REALTY INCOME CORP', '10672', 'US7561091049', 'NYSE', 'REIT'],
  NDAQ: ['NASDAQ INC', '29380756', 'US6311031081', 'NASDAQ', 'COMMON'],
  XLP: ['SS CONSUMER STAPLES SEL SECT', '4215210', 'US81369Y3080', 'ARCA', 'ETF'],
  MU: ['MICRON TECHNOLOGY INC', '9939', 'US5951121038', 'NASDAQ', 'COMMON'],
  GOOG: ['ALPHABET INC-CL C', '208813720', 'US02079K1079', 'NASDAQ', 'COMMON'],
  ASML: ['ASML HOLDING NV-NY REG SHS', '117902840', 'USN070592100', 'NASDAQ', 'NY REG SHRS'],
  NVDA: ['NVIDIA CORP', '4815747', 'US67066G1040', 'NASDAQ', 'COMMON'],
  AMZN: ['AMAZON.COM INC', '3691937', 'US0231351067', 'NASDAQ', 'COMMON'],
  BND: ['VANGUARD TOTAL BOND MARKET', '43645828', 'US9219378356', 'NASDAQ', 'ETF'],
  XBI: ['SS SPDR S&P BIOTECH ETF', '45540828', 'US78464A8707', 'ARCA', 'ETF'],
};
// Relative target weights for new money; the demo leans on ETFs like the real account.
const TARGETS = { SCHD: 16, VXUS: 14, AVUV: 12, QQQ: 14, V: 6, MSFT: 6, O: 6, NDAQ: 4, XLP: 4, MU: 3, GOOG: 5, ASML: 4, NVDA: 3, AMZN: 3, BND: 5, XBI: 3 };
const FRACTIONAL = new Set(['ASML', 'MU', 'QQQ', 'MSFT']);
// Approximate per-share cash dividends: [months, day of month, amount].
const DIVS = {
  SCHD: [[3, 6, 9], 25, 0.26], VXUS: [[3, 6, 9], 22, 0.31], V: [[3, 6, 9], 2, 0.67], MSFT: [[3, 6, 9], 11, 0.91],
  XLP: [[3, 6, 9], 24, 0.54], QQQ: [[3, 6, 9], 30, 0.72], O: [[1, 2, 3, 4, 5, 6, 7, 8, 9], 15, 0.27], BND: [[1, 2, 3, 4, 5, 6, 7, 8, 9], 5, 0.23],
  AVUV: [[3, 6, 9], 26, 0.41], NDAQ: [[3, 6, 9], 27, 0.27], GOOG: [[3, 6, 9], 16, 0.21],
};
// Scheduled sales: [date, symbol, fraction of the holding].
const SELLS = [['2026-02-20', 'NVDA', 0.5], ['2026-03-18', 'AMZN', 1], ['2026-04-22', 'GOOG', 1], ['2026-05-19', 'XBI', 1],
  ['2026-06-17', 'ASML', 1], ['2026-07-21', 'BND', 1], ['2026-08-18', 'NVDA', 1], ['2026-09-15', 'QQQ', 0.3]];

/* ---------- simulate ---------- */
const deposits = [], forex = [], trades = [], dividends = [], withholding = [], interest = [];
const lots = {};
let usd = 0, eur = 0;
const heldQty = s => (lots[s] || []).reduce((a, l) => a + l.qty, 0);
const time = () => `${String(9 + Math.floor(between(0.6, 6.8))).padStart(2, '0')}:${String(Math.floor(between(0, 60))).padStart(2, '0')}:${String(Math.floor(between(0, 60))).padStart(2, '0')}`;
const r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

// Deposit schedule: a larger opening transfer, then roughly monthly top-ups.
const depositPlan = [['2026-01-05', 4200]];
for (let m = 1; m <= 9; m++) {
  const d = `${YEAR}-${String(m).padStart(2, '0')}-${String(Math.floor(between(3, 20))).padStart(2, '0')}`;
  if (m === 1) continue;
  depositPlan.push([d, Math.round(between(450, 1350) / 25) * 25]);
  if (rnd() < 0.3) depositPlan.push([`${YEAR}-${String(m).padStart(2, '0')}-${String(Math.floor(between(21, 28))).padStart(2, '0')}`, Math.round(between(200, 600) / 25) * 25]);
}
const depositByDay = new Map();
for (const [d, amt] of depositPlan) if (d <= lastDay) { const day = dayOnOrAfter(d); depositByDay.set(day, (depositByDay.get(day) || 0) + amt); }
const reinvestDays = new Set();
const sellByDay = new Map(SELLS.filter(([d]) => d <= lastDay).map(([d, s, f]) => [dayOnOrAfter(d), [s, f]]));

function buy(day, sym, budget) {
  const close = closeOn(sym, day);
  const price = r(close * (1 + between(-0.003, 0.003)), close > 100 ? 2 : 3);
  let qty = FRACTIONAL.has(sym) ? r((budget - 1) / price, 4) : Math.floor((budget - 1) / price);
  if (qty <= 0) return 0;
  const proceeds = -qty * price, comm = -1;
  usd += proceeds + comm;
  (lots[sym] ||= []).push({ qty, cost: (-proceeds - comm) / qty });
  trades.push({ sym, dt: `${day}, ${time()}`, qty, price, close, proceeds, comm, basis: -proceeds - comm, realized: 0, code: 'O' });
  return -proceeds - comm;
}
function sell(day, sym, frac) {
  const have = heldQty(sym);
  if (have <= 0) return;
  let qty = frac >= 1 ? have : (FRACTIONAL.has(sym) ? r(have * frac, 4) : Math.max(1, Math.floor(have * frac)));
  const close = closeOn(sym, day);
  const price = r(close * (1 + between(-0.003, 0.003)), close > 100 ? 2 : 3);
  const proceeds = qty * price, comm = -1;
  let left = qty, basis = 0;
  const L = lots[sym];
  while (left > 1e-9 && L.length) { const l = L[0], take = Math.min(left, l.qty); basis += take * l.cost; l.qty -= take; left -= take; if (l.qty <= 1e-9) L.shift(); }
  usd += proceeds + comm;
  trades.push({ sym, dt: `${day}, ${time()}`, qty: -qty, price, close, proceeds, comm, basis: -basis, realized: proceeds + comm - basis, code: 'C' });
}

for (const day of days) {
  if (depositByDay.has(day)) { const amt = depositByDay.get(day); eur += amt; deposits.push({ day, amt }); }
  // Convert EUR the next trading day after it arrives.
  if (eur > 0 && deposits.at(-1)?.day !== day) {
    const rate = r(closeOn('FX_EUR', day) * (1 + between(-0.0005, 0.0005)), 5);
    forex.push({ dt: `${day}, ${time()}`, qty: -eur, price: rate, proceeds: eur * rate, comm: -2 });
    usd += eur * rate - 2; eur = 0;
    // The first conversion buys a starter basket that includes the names sold later;
    // after that, new cash is spread over 3–5 names by target weight.
    const starter = forex.length === 1 ? ['SCHD', 'VXUS', 'QQQ', 'GOOG', 'AMZN', 'NVDA', 'ASML', 'XBI', 'BND', 'O'] : null;
    const names = Object.keys(TARGETS).filter(s => closeOn(s, day) && !SELLS.some(([d, s2, f]) => s2 === s && f >= 1 && d <= day));
    const chosen = new Set();
    while (chosen.size < Math.min(names.length, 3 + Math.floor(rnd() * 3))) {
      const tot = names.filter(n => !chosen.has(n)).reduce((a, n) => a + TARGETS[n], 0);
      let x = rnd() * tot;
      for (const n of names) { if (chosen.has(n)) continue; x -= TARGETS[n]; if (x <= 0) { chosen.add(n); break; } }
    }
    const budget = usd - 25;
    if (starter) for (const n of starter) buy(day, n, budget / starter.length);
    else {
      const wsum = [...chosen].reduce((a, n) => a + TARGETS[n], 0);
      for (const n of chosen) buy(day, n, budget * TARGETS[n] / wsum);
    }
  }
  if (sellByDay.has(day)) {
    const [s, f] = sellByDay.get(day);
    sell(day, s, f);
    // Reinvest the proceeds a couple of days later.
    reinvestDays.add(nextDay(day, 2));
  }
  if (reinvestDays.has(day) && usd > 150) {
    const pool = ['SCHD', 'VXUS', 'AVUV', 'V', 'NDAQ'];
    const a = pick(pool); let b = pick(pool); while (b === a) b = pick(pool);
    const budget = usd - 25;
    buy(day, a, budget * 0.55); buy(day, b, usd - 25);
  }
  // Dividends paid on holdings as of the pay date.
  const [, mo, dd] = day.split('-').map(Number);
  for (const [sym, [months, dom, rate]] of Object.entries(DIVS)) {
    if (!months.includes(mo)) continue;
    const payDay = dayOnOrAfter(`${YEAR}-${String(mo).padStart(2, '0')}-${String(dom).padStart(2, '0')}`);
    if (payDay !== day) continue;
    const q = heldQty(sym);
    if (q <= 0) continue;
    const amt = r(q * rate, 2), tax = -r(amt * 0.15, 2);
    const isin = INSTRUMENTS[sym][2];
    dividends.push({ day, sym, isin, rate, amt });
    withholding.push({ day, sym, isin, rate, amt: tax });
    usd += amt + tax;
  }
  if (dd <= 7 && mo > 1 && !interest.some(i => i.month === mo) && usd > 0) {
    const amt = r(between(0.05, 0.9), 2);
    const prev = new Date(Date.UTC(+YEAR, mo - 2, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    interest.push({ day, month: mo, amt, desc: `USD IBKR Managed Securities (SYEP) Interest for ${prev}-${YEAR}` });
    usd += amt;
  }
}

/* ---------- CSV writing ---------- */
const q = v => { const s = typeof v === 'number' ? String(r(v, 9)) : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...cells) => cells.map(q).join(',');
const fmtLong = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function build(summary) {
  const L = [];
  L.push(row('Statement', 'Header', 'Field Name', 'Field Value'));
  L.push(row('Statement', 'Data', 'BrokerName', 'Interactive Brokers LLC'));
  L.push(row('Statement', 'Data', 'Title', 'Activity Statement'));
  L.push(row('Statement', 'Data', 'Period', `${fmtLong(`${YEAR}-01-01`)} - ${fmtLong(lastDay)}`));
  L.push(row('Statement', 'Data', 'WhenGenerated', `${lastDay}, 18:00:00 EDT`));
  L.push(row('Account Information', 'Header', 'Field Name', 'Field Value'));
  L.push(row('Account Information', 'Data', 'Name', 'Demo Investor'));
  L.push(row('Account Information', 'Data', 'Account', 'U0000000'));
  L.push(row('Account Information', 'Data', 'Account Type', 'Individual'));
  L.push(row('Account Information', 'Data', 'Account Capabilities', 'Cash'));
  L.push(row('Account Information', 'Data', 'Base Currency', 'USD'));
  if (summary) {
    const { nav, cash, stock, twr, change } = summary;
    L.push(row('Net Asset Value', 'Header', 'Asset Class', 'Prior Total', 'Current Long', 'Current Short', 'Current Total', 'Change'));
    L.push(row('Net Asset Value', 'Data', 'Cash ', 0, cash, 0, cash, cash));
    L.push(row('Net Asset Value', 'Data', 'Stock', 0, stock, 0, stock, stock));
    L.push(row('Net Asset Value', 'Data', 'Total', 0, nav, 0, nav, nav));
    L.push(row('Net Asset Value', 'Header', 'Time Weighted Rate of Return'));
    L.push(row('Net Asset Value', 'Data', `${(twr * 100).toFixed(9)}%`));
    L.push(row('Change in NAV', 'Header', 'Field Name', 'Field Value'));
    for (const [k, v] of change) L.push(row('Change in NAV', 'Data', k, v));
    L.push(row('Cash Report', 'Header', 'Currency Summary', 'Currency', 'Total', 'Securities', 'Futures', ''));
    L.push(row('Cash Report', 'Data', 'Starting Cash', 'Base Currency Summary', 0, 0, 0, ''));
    L.push(row('Cash Report', 'Data', 'Ending Cash', 'Base Currency Summary', cash, cash, 0, ''));
    L.push(row('Open Positions', 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Quantity', 'Mult', 'Cost Price', 'Cost Basis', 'Close Price', 'Value', 'Unrealized P/L', 'Code'));
    for (const p of summary.open) L.push(row('Open Positions', 'Data', 'Summary', 'Stocks', 'USD', p.symbol, r(p.qty, 4), 1, p.costBasis / p.qty, p.costBasis, p.price, r(p.value, 2), p.value - p.costBasis, ''));
    L.push(row('Mark-to-Market Performance Summary', 'Header', 'Asset Category', 'Symbol', 'Prior Quantity', 'Current Quantity', 'Prior Price', 'Current Price', 'Mark-to-Market P/L Position', 'Mark-to-Market P/L Transaction', 'Mark-to-Market P/L Commissions', 'Mark-to-Market P/L Other', 'Mark-to-Market P/L Total', 'Code'));
    for (const p of summary.all) L.push(row('Mark-to-Market Performance Summary', 'Data', 'Stocks', p.symbol, 0, r(p.qty, 4), '--', p.open ? p.price.toFixed(4) : '--', 0, 0, p.commissions, 0, p.total, ''));
  }
  L.push(row('Trades', 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Date/Time', 'Quantity', 'T. Price', 'C. Price', 'Proceeds', 'Comm/Fee', 'Basis', 'Realized P/L', 'MTM P/L', 'Code'));
  const bySym = [...trades].sort((a, b) => a.sym.localeCompare(b.sym) || a.dt.localeCompare(b.dt));
  for (const t of bySym) L.push(row('Trades', 'Data', 'Order', 'Stocks', 'USD', t.sym, t.dt, r(t.qty, 4), t.price, t.close, r(t.proceeds, 6), t.comm, r(t.basis, 6), r(t.realized, 6), r((t.close - t.price) * t.qty, 4), t.code));
  L.push(row('Trades', 'Header', 'DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Date/Time', 'Quantity', 'T. Price', '', 'Proceeds', 'Comm in USD', '', '', 'MTM in USD', 'Code'));
  for (const f of forex) L.push(row('Trades', 'Data', 'Order', 'Forex', 'USD', 'EUR.USD', f.dt, r(f.qty, 2).toLocaleString('en-US'), f.price, '', r(f.proceeds, 6), f.comm, '', '', 0, ''));
  L.push(row('Deposits & Withdrawals', 'Header', 'Currency', 'Settle Date', 'Description', 'Amount'));
  for (const d of deposits) L.push(row('Deposits & Withdrawals', 'Data', 'EUR', d.day, 'Electronic Fund Transfer', d.amt));
  const eurTotal = deposits.reduce((a, d) => a + d.amt, 0);
  const usdTotal = forex.reduce((a, f) => a + f.proceeds, 0);
  L.push(row('Deposits & Withdrawals', 'Data', 'Total', '', '', eurTotal));
  L.push(row('Deposits & Withdrawals', 'Data', 'Total in USD', '', '', r(usdTotal, 6)));
  L.push(row('Deposits & Withdrawals', 'Data', 'Total Deposits & Withdrawals in USD', '', '', r(usdTotal, 6)));
  L.push(row('Dividends', 'Header', 'Currency', 'Date', 'Description', 'Amount'));
  for (const d of dividends) L.push(row('Dividends', 'Data', 'USD', d.day, `${d.sym}(${d.isin}) Cash Dividend USD ${d.rate} per Share (Ordinary Dividend)`, d.amt));
  L.push(row('Dividends', 'Data', 'Total', '', '', r(dividends.reduce((a, d) => a + d.amt, 0), 2)));
  L.push(row('Withholding Tax', 'Header', 'Currency', 'Date', 'Description', 'Amount', 'Code'));
  for (const d of withholding) L.push(row('Withholding Tax', 'Data', 'USD', d.day, `${d.sym}(${d.isin}) Cash Dividend USD ${d.rate} per Share - US Tax`, d.amt, ''));
  L.push(row('Withholding Tax', 'Data', 'Total', '', '', r(withholding.reduce((a, d) => a + d.amt, 0), 2), ''));
  L.push(row('Interest', 'Header', 'Currency', 'Date', 'Description', 'Amount'));
  for (const i of interest) L.push(row('Interest', 'Data', 'USD', i.day, i.desc, i.amt));
  L.push(row('Interest', 'Data', 'Total', '', '', r(interest.reduce((a, i) => a + i.amt, 0), 2)));
  L.push(row('Financial Instrument Information', 'Header', 'Asset Category', 'Symbol', 'Description', 'Conid', 'Security ID', 'Underlying', 'Listing Exch', 'Multiplier', 'Type', 'Code'));
  for (const s of [...new Set(trades.map(t => t.sym))].sort()) {
    const [name, conid, isin, exch, type] = INSTRUMENTS[s];
    L.push(row('Financial Instrument Information', 'Data', 'Stocks', s, name, conid, isin, s, exch, 1, type, ''));
  }
  return '﻿' + L.join('\n') + '\n';
}

// Pass 1: activity only. Pass 2: fill in NAV and positions using the dashboard's own engine.
const draft = build(null);
const model = parseFiles([{ name: 'draft.csv', text: draft }]);
const need = neededSymbols(model);
const cache = {};
for (const s of [...need.symbols, ...need.benchmarks, ...need.fx]) {
  const f = path.join(root, 'data/prices', cacheFileName(s));
  if (fs.existsSync(f)) cache[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
}
const { kpis: k, ledger } = analyze(model, cache);
const open = ledger.positions.filter(p => p.open).sort((a, b) => a.symbol.localeCompare(b.symbol));
const stock = open.reduce((a, p) => a + r(p.value, 2), 0);
const summary = {
  nav: stock + k.cash, cash: k.cash, stock, twr: k.twr, open, all: [...ledger.positions].sort((a, b) => a.symbol.localeCompare(b.symbol)),
  change: [['Starting Value', 0], ['Mark-to-Market', k.gain - k.dividends - k.tax - k.interest - k.fees - k.commissions], ['Deposits & Withdrawals', k.netDeposits],
    ['Dividends', k.dividends], ['Withholding Tax', k.tax], ['Interest', k.interest], ['Commissions', k.commissions], ['Ending Value', stock + k.cash]],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, build(summary));
console.log(`Wrote ${path.relative(root, OUT)}: ${deposits.length} deposits (€${deposits.reduce((a, d) => a + d.amt, 0).toLocaleString()}), ${trades.length} trades, ${dividends.length} dividends`);
console.log(`NAV $${summary.nav.toFixed(2)} · deposits $${k.netDeposits.toFixed(2)} · TWR ${(k.twr * 100).toFixed(2)}% · open ${open.length} · closed ${ledger.positions.length - open.length}`);
