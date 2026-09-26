// Dashboard wiring: file intake, persistence, and rendering of every section.
import { parseFiles, analyze, neededSymbols } from './engine.js';
import { loadPriceCache } from './prices.js';
import { twrIndex, drawdown, periodReturns, benchmarkSameFlows, priceIndex } from './metrics.js';
import { addDays } from './ledger.js';

const $ = sel => document.querySelector(sel);
const STORE_KEY = 'stokkks.files.v1';
const THEME_KEY = 'stokkks.theme';
const EMBED = window.STOKKKS_EMBED || null; // set by the single-file preview build
const DEMO_URL = 'demo/demo-statement-2026.csv';

let files = [];
let state = null;          // { model, book, ledger, kpis, extras }
let charts = {};
let selected = null;
let range = 'ALL';
let demo = false;           // showing the bundled fictional statement

/* ---------- formatting ---------- */
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, d = 0) => !isFinite(v) ? '—' : (v < 0 ? '−$' : '$') + (d ? nf2 : nf0).format(Math.abs(v));
const signed = (v, d = 0) => !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + (d ? nf2 : nf0).format(Math.abs(v));
const pct = (v, d = 1) => !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d) + '%';
const qtyFmt = q => !isFinite(q) ? '—' : Math.abs(q - Math.round(q)) < 1e-9 ? nf0.format(q) : q.toFixed(4).replace(/0+$/, '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const fmtDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- theme ---------- */
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  return {
    ink: g('--ink'), ink2: g('--ink-2'), muted: g('--muted'), hair: g('--hair'), axis: g('--axis'), surface: g('--surface'),
    s1: g('--s1'), s2: g('--s2'), s3: g('--s3'), s4: g('--s4'), s5: g('--s5'), s6: g('--s6'), s7: g('--s7'), other: g('--other'),
    gain: g('--gain'), loss: g('--loss'), deposit: g('--deposit'), accent: g('--accent'), sans: g('--sans'), mono: g('--mono'),
  };
}
function initTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch {}
  $('#btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    if (state) renderCharts();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state) renderCharts(); });
}

/* ---------- files ---------- */
function saveFiles() {
  if (demo) return; // the demo never replaces the viewer's own saved statements
  try { localStorage.setItem(STORE_KEY, JSON.stringify(files)); } catch { /* quota or disabled: stays in memory */ }
}
function loadStoredFiles() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
async function addFiles(list) {
  const incoming = await Promise.all([...list].map(async f => ({ name: f.name, text: await f.text() })));
  if (demo) { demo = false; files = []; clearDemoHash(); }
  for (const f of incoming) {
    const i = files.findIndex(x => x.name === f.name);
    if (i >= 0) files[i] = f; else files.push(f);
  }
  saveFiles();
  await run();
}
async function loadDemo() {
  let text;
  try {
    const res = await fetch(DEMO_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch {
    showEmptyError('The demo statement could not be loaded. If you opened index.html straight from disk, serve the folder instead: run python3 -m http.server and open http://localhost:8000.', true);
    return;
  }
  demo = true;
  files = [{ name: 'demo-statement-2026.csv', text }];
  selected = null;
  await run();
}
function exitDemo() {
  demo = false;
  clearDemoHash();
  files = loadStoredFiles();
  selected = null;
  if (files.length) { run(); return; }
  state = null; disposeCharts();
  $('#report').hidden = true; $('#empty').hidden = false; $('#btn-clear').hidden = true;
  $('#acct-line').textContent = 'Portfolio report';
}
function clearDemoHash() {
  if (location.hash === '#demo') history.replaceState(null, '', location.pathname + location.search);
}
function initIntake() {
  $('#btn-demo').addEventListener('click', () => loadDemo());
  $('#file-input').addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });
  $('#btn-clear').addEventListener('click', () => {
    const b = $('#btn-clear');
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click again to forget'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Forget data'; }, 3000); return; }
    files = []; saveFiles(); state = null; disposeCharts();
    $('#report').hidden = true; $('#empty').hidden = false; b.hidden = true; b.dataset.confirm = ''; b.textContent = 'Forget data';
    $('#acct-line').textContent = 'Portfolio report';
  });
  let depth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; $('#dropveil').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('#dropveil').hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; $('#dropveil').hidden = true;
    const fs = [...(e.dataTransfer?.files || [])].filter(f => /\.csv$/i.test(f.name) || f.type === 'text/csv');
    if (fs.length) addFiles(fs);
  });
}

/* ---------- pipeline ---------- */
async function run() {
  if (!files.length) return;
  let model;
  try { model = parseFiles(files); }
  catch (err) {
    showEmptyError(err.message);
    return;
  }
  const need = neededSymbols(model);
  const cache = EMBED?.prices || await loadPriceCache([...need.symbols, ...need.benchmarks, ...need.fx]);
  state = analyze(model, cache);
  state.cache = cache;
  state.extras = buildExtras(state);
  if (!selected || !state.ledger.positions.find(p => p.symbol === selected)) selected = state.ledger.positions[0]?.symbol;
  $('#empty').hidden = true; $('#report').hidden = false; $('#btn-clear').hidden = !!EMBED || demo;
  renderAll();
}
function showEmptyError(msg, raw = false) {
  $('#empty').hidden = false; $('#report').hidden = true;
  let p = $('#drop .err');
  if (!p) { p = document.createElement('p'); p.className = 'err banner'; $('#drop').appendChild(p); }
  p.textContent = raw ? msg : `Could not read that file: ${msg}. Export the Activity Statement from IBKR in CSV format and try again.`;
}

function buildExtras({ ledger, book, kpis }) {
  const s = ledger.series;
  const bench = {};
  for (const sym of ['SPY', 'QQQ']) {
    if (book[sym]?.source === 'market') {
      bench[sym] = { same: benchmarkSameFlows(s, book[sym].at), idx: null };
      const first = s.nav.findIndex(v => v > 1);
      bench[sym].idx = priceIndex(s, book[sym].at, Math.max(0, first));
    }
  }
  return { bench, monthly: periodReturns(s.dates, kpis.index, 7), yearly: periodReturns(s.dates, kpis.index, 4) };
}

/* ---------- render ---------- */
function renderAll() {
  const { model, kpis, ledger } = state;
  const acct = model.accounts.join(', ');
  $('#acct-line').textContent = `${model.name || 'Account'} · ${acct} · ${model.baseCcy}`;
  renderBanners();
  renderHero();
  renderOpenTable();
  renderClosedTable();
  renderDetailSelect();
  renderDetailText();
  renderDivTable();
  renderRecon();
  renderYears();
  renderTradeFilter();
  renderTrades();
  renderFoot();
  renderCharts();
}

function renderBanners() {
  const { model, ledger, book } = state;
  const out = [];
  if (demo) out.push('<b>You are viewing a demo portfolio.</b> The account, deposits and trades are fictional; prices are real daily closes. Add your own statements to replace it.<button class="btn btn-sm" id="btn-exit-demo" type="button">Exit demo</button>');
  const stmtOnly = ledger.positions.filter(p => p.priceSource !== 'market').map(p => p.symbol);
  if (stmtOnly.length) {
    out.push(`<b>${stmtOnly.length} of ${ledger.positions.length} symbols have no daily price file yet</b>, so their charts join the prices found in your statements (trade-day closes and period-end marks) with straight lines. Totals are exact; the lines between trades are approximate. To get daily prices, add ${stmtOnly.slice(0, 8).map(s => `<code>${esc(s)}</code>`).join(' ')}${stmtOnly.length > 8 ? ' …' : ''} to <code>data/tickers.json</code> in the repository; the price workflow fetches them.`);
  }
  if (!book.SPY || book.SPY.source !== 'market') out.push('Index comparisons (S&amp;P 500, Nasdaq-100) appear once the price cache includes <code>SPY</code> and <code>QQQ</code>.');
  for (const w of model.warnings) out.push(esc(w));
  $('#banners').innerHTML = out.map((t, i) => `<div class="banner${demo && i === 0 ? ' banner-demo' : ''}" role="note"><span class="ico">i</span><div>${t}</div></div>`).join('');
  $('#btn-exit-demo')?.addEventListener('click', exitDemo);
}

function renderHero() {
  const { kpis: k, model, ledger } = state;
  $('#hero-period').textContent = `${fmtDate(ledger.startDate)} — ${fmtDate(ledger.endDate)} · ${model.statements.length} statement${model.statements.length > 1 ? 's' : ''}`;
  const dir = k.gain >= 0 ? 'up' : 'down';
  $('#hero-line').innerHTML = `You deposited <em>${money(k.netDeposits)}</em>. It is worth <em>${money(k.nav)}</em> today, <em class="${dir}">${signed(k.gain)}</em> (${pct(k.gainPct)}).`;
  const items = [
    ['Portfolio value', money(k.nav), `${money(k.invested)} invested · ${money(k.cash)} cash`],
    ['Net deposited', money(k.netDeposits), `${ledger.deposits.length} transfers`],
    ['Total profit', `<span class="${cls(k.gain)}">${signed(k.gain)}</span>`, `${money(k.realized)} realized · ${money(k.unrealized)} open`],
    ['Time-weighted return', `<span class="${cls(k.twr)}">${pct(k.twr)}</span>`, `IBKR reports ${pct(k.ibkrTwrChain)}`],
    ['Money-weighted (IRR)', `<span class="${cls(k.xirr)}">${pct(k.xirr)}</span>`, 'per year, on your deposit timing'],
    ['Dividends, net', money(k.dividends + k.tax), `${money(k.dividends)} gross · ${money(-k.tax)} tax`],
    ['Max drawdown', `<span class="${cls(k.maxDD)}">${pct(k.maxDD)}</span>`, k.maxDD < 0 ? `${fmtDate(k.ddPeak)} → ${fmtDate(k.ddTrough)}` : 'none'],
    ['Costs', money(-k.commissions), `${k.tradeCount} trades · win rate ${isFinite(k.winRate) ? Math.round(k.winRate * 100) + '%' : '—'}`],
  ];
  $('#kpis').innerHTML = items.map(([t, v, n]) => `<div class="kpi"><dt>${t}</dt><dd>${v}</dd><div class="note">${n}</div></div>`).join('');
}

function posRow(p, total) {
  const w = total ? p.value / total : 0;
  const irr = p.holdingDays >= 90 ? pct(p.irr) : '—';
  return `<tr class="clickable${p.symbol === selected ? ' sel' : ''}" tabindex="0" data-sym="${esc(p.symbol)}">
    <td class="sym">${esc(p.symbol)}<small>${esc(p.name)}</small></td>
    <td>${qtyFmt(p.qty)}</td><td>${money(p.avgCost, 2)}</td><td>${money(p.price, 2)}</td>
    <td>${money(p.value)}</td><td><span class="bar" style="width:${Math.max(2, w * 60)}px"></span> ${(w * 100).toFixed(1)}%</td>
    <td class="${cls(p.unrealized)}">${signed(p.unrealized)}<br><small>${pct(p.costBasis ? p.unrealized / p.costBasis : NaN)}</small></td>
    <td class="${cls(p.realized)}">${signed(p.realized)}</td><td>${money(p.income)}</td>
    <td class="${cls(p.total)}"><b>${signed(p.total)}</b></td><td class="${cls(p.irr)}">${irr}</td></tr>`;
}
function renderOpenTable() {
  const open = state.ledger.positions.filter(p => p.open);
  const total = state.kpis.nav;
  const sum = f => open.reduce((a, p) => a + p[f], 0);
  $('#tbl-open').innerHTML = `<thead><tr><th>Position</th><th>Qty</th><th>Avg cost</th><th>Price</th><th>Value</th><th>Weight</th><th>Unrealized</th><th>Realized</th><th>Dividends</th><th>Total P/L</th><th title="Annualised, shown after 90 days held">IRR</th></tr></thead>
    <tbody>${open.map(p => posRow(p, total)).join('')}</tbody>
    <tfoot><tr><td>Total · cash ${money(state.kpis.cash)}</td><td></td><td></td><td></td><td>${money(sum('value'))}</td><td></td><td class="${cls(sum('unrealized'))}">${signed(sum('unrealized'))}</td><td class="${cls(sum('realized'))}">${signed(sum('realized'))}</td><td>${money(sum('income'))}</td><td class="${cls(sum('total'))}">${signed(sum('total'))}</td><td></td></tr></tfoot>`;
  bindRows('#tbl-open');
}
function renderClosedTable() {
  const closed = state.ledger.positions.filter(p => !p.open).sort((a, b) => b.total - a.total);
  $('#tbl-closed').innerHTML = `<thead><tr><th>Position</th><th>First buy</th><th>Last sale</th><th>Days</th><th>Bought</th><th>Sold</th><th>Realized</th><th>Dividends</th><th>Total P/L</th><th>Return</th></tr></thead>
    <tbody>${closed.map(p => `<tr class="clickable${p.symbol === selected ? ' sel' : ''}" tabindex="0" data-sym="${esc(p.symbol)}">
      <td class="sym">${esc(p.symbol)}<small>${esc(p.name)}</small></td><td>${fmtDate(p.firstDate)}</td><td>${fmtDate(p.lastDate)}</td><td>${p.holdingDays}</td>
      <td>${money(p.bought)}</td><td>${money(p.sold)}</td><td class="${cls(p.realized)}">${signed(p.realized)}</td><td>${money(p.income)}</td>
      <td class="${cls(p.total)}"><b>${signed(p.total)}</b></td><td class="${cls(p.returnOnCapital)}">${pct(p.returnOnCapital)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>${closed.length} closed</td><td></td><td></td><td></td><td>${money(closed.reduce((a, p) => a + p.bought, 0))}</td><td>${money(closed.reduce((a, p) => a + p.sold, 0))}</td><td>${signed(closed.reduce((a, p) => a + p.realized, 0))}</td><td>${money(closed.reduce((a, p) => a + p.income, 0))}</td><td>${signed(closed.reduce((a, p) => a + p.total, 0))}</td><td></td></tr></tfoot>`;
  bindRows('#tbl-closed');
}
function bindRows(sel) {
  document.querySelectorAll(`${sel} tr.clickable`).forEach(tr => {
    const go = () => selectPosition(tr.dataset.sym, true);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}
function selectPosition(sym, scroll) {
  selected = sym;
  document.querySelectorAll('tr.clickable').forEach(tr => tr.classList.toggle('sel', tr.dataset.sym === sym));
  $('#detail-select').value = sym;
  renderDetailText();
  renderDetailCharts();
  if (scroll) $('#detail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function renderDetailSelect() {
  const ps = state.ledger.positions;
  const opt = p => `<option value="${esc(p.symbol)}">${esc(p.symbol)} · ${esc(p.name)}</option>`;
  $('#detail-select').innerHTML = `<optgroup label="Open">${ps.filter(p => p.open).map(opt).join('')}</optgroup><optgroup label="Closed">${ps.filter(p => !p.open).map(opt).join('')}</optgroup>`;
  $('#detail-select').value = selected;
  $('#detail-select').onchange = e => selectPosition(e.target.value, false);
}
function renderDetailText() {
  const p = state.ledger.positions.find(x => x.symbol === selected);
  if (!p) return;
  const src = p.priceSource === 'market' ? 'daily closes' : 'statement prices joined by straight lines';
  $('#detail-title').textContent = `${p.symbol} · ${p.name}`;
  $('#detail-sub').textContent = `${p.type ? p.type + ' · ' : ''}${p.open ? 'Open' : 'Closed'} · first bought ${fmtDate(p.firstDate)} · price line from ${src}`;
  const items = p.open ? [
    ['Value', money(p.value), `${qtyFmt(p.qty)} × ${money(p.price, 2)}`],
    ['Average cost', money(p.avgCost, 2), `cost basis ${money(p.costBasis)}`],
    ['Unrealized', `<span class="${cls(p.unrealized)}">${signed(p.unrealized)}</span>`, pct(p.costBasis ? p.unrealized / p.costBasis : NaN)],
  ] : [
    ['Bought', money(p.bought), plural(p.trades.filter(t => t.side === 'BUY').length, 'buy')],
    ['Sold', money(p.sold), plural(p.trades.filter(t => t.side === 'SELL').length, 'sale')],
    ['Held', `${p.holdingDays} days`, `${fmtDate(p.firstDate)} → ${fmtDate(p.lastDate)}`],
  ];
  items.push(
    ['Realized', `<span class="${cls(p.realized)}">${signed(p.realized)}</span>`, plural(p.trades.filter(t => t.side === 'SELL').length, 'sale')],
    ['Dividends, net', money(p.income), `${money(p.dividends)} gross`],
    ['Total P/L', `<span class="${cls(p.total)}">${signed(p.total)}</span>`, `${pct(p.returnOnCapital)} of ${money(p.bought)} put in`],
    ['Commissions', money(-p.commissions, 2), plural(p.trades.length, 'trade')],
    ['IRR', p.holdingDays >= 90 ? `<span class="${cls(p.irr)}">${pct(p.irr)}</span>` : '—', p.holdingDays >= 90 ? 'annualised, money-weighted' : 'held under 90 days'],
  );
  $('#detail-kpis').innerHTML = items.map(([t, v, n]) => `<div class="kpi"><dt>${t}</dt><dd>${v}</dd><div class="note">${n}</div></div>`).join('');
  $('#tbl-detail-trades').innerHTML = tradeTable(p.trades.slice().reverse(), false);
}
function tradeTable(trades, withSym = true) {
  return `<thead><tr><th>Date</th>${withSym ? '<th class="l">Symbol</th>' : ''}<th class="l">Side</th><th>Qty</th><th>Price</th><th>Amount</th><th>Commission</th><th>Realized</th><th>Position after</th></tr></thead>
  <tbody>${trades.map(t => `<tr><td>${fmtDate(t.date)} <small class="muted">${t.dt.slice(11, 16)}</small></td>${withSym ? `<td class="l sym">${esc(t.symbol)}</td>` : ''}
    <td class="l"><span class="pill ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? 'Buy' : 'Sell'}</span></td>
    <td>${qtyFmt(Math.abs(t.qty))}</td><td>${money(t.price, 2)}</td><td>${money(t.amount, 2)}</td><td>${money(t.comm, 2)}</td>
    <td class="${cls(t.realizedBase)}">${t.side === 'SELL' ? signed(t.realizedBase, 2) : ''}</td><td>${qtyFmt(t.qtyAfter)}</td></tr>`).join('')}</tbody>`;
}
function renderTradeFilter() {
  const syms = [...new Set(state.ledger.positions.map(p => p.symbol))].sort();
  $('#trades-filter').innerHTML = `<option value="">All symbols</option><option value="BUY">Buys only</option><option value="SELL">Sales only</option>${syms.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}`;
  $('#trades-filter').onchange = renderTrades;
}
function renderTrades() {
  const f = $('#trades-filter').value;
  let all = state.ledger.positions.flatMap(p => p.trades).sort((a, b) => b.dt.localeCompare(a.dt));
  if (f === 'BUY' || f === 'SELL') all = all.filter(t => t.side === f);
  else if (f) all = all.filter(t => t.symbol === f);
  const buys = all.filter(t => t.side === 'BUY').reduce((a, t) => a + t.amount, 0);
  const sells = all.filter(t => t.side === 'SELL').reduce((a, t) => a + t.amount, 0);
  $('#trades-sub').textContent = `${all.length} trades · ${money(buys)} bought · ${money(sells)} sold`;
  $('#tbl-trades').innerHTML = tradeTable(all, true);
}
function monthlyDividends() {
  const m = new Map();
  for (const d of [...state.model.dividends, ...state.model.withholding]) {
    const k = d.date.slice(0, 7);
    m.set(k, (m.get(k) || 0) + d.amount * state.book.fx(d.ccy)(d.date));
  }
  // Fill every month in range so gaps show as zero.
  const out = [];
  for (let d = state.ledger.startDate.slice(0, 7); d <= state.ledger.endDate.slice(0, 7);) {
    out.push([d, m.get(d) || 0]);
    const [y, mo] = d.split('-').map(Number);
    d = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}
function renderDivTable() {
  const ps = state.ledger.positions.filter(p => p.dividends).sort((a, b) => b.income - a.income).slice(0, 8);
  $('#tbl-divs').innerHTML = `<thead><tr><th>Top payers</th><th>Gross</th><th>Tax</th><th>Net</th><th>Yield on cost</th></tr></thead><tbody>${ps.map(p =>
    `<tr><td class="sym">${esc(p.symbol)}</td><td>${money(p.dividends, 2)}</td><td>${money(p.tax, 2)}</td><td>${money(p.income, 2)}</td><td>${p.open && p.costBasis ? pct(p.income / p.costBasis) : '—'}</td></tr>`).join('')}</tbody>`;
}
function renderRecon() {
  const k = state.kpis;
  $('#tbl-recon').innerHTML = `<thead><tr><th>Statement</th><th>IBKR NAV</th><th>Rebuilt</th><th>Diff</th><th>IBKR TWR</th></tr></thead><tbody>${k.recon.map(r =>
    `<tr><td>${esc(r.period)}</td><td>${money(r.statementNav, 2)}</td><td>${money(r.computed + r.accruals, 2)}</td><td>${signed(r.diff, 2)}</td><td>${pct(r.ibkrTwr, 2)}</td></tr>`).join('')}</tbody>`;
}
function renderYears() {
  const { yearly } = state.extras;
  const b = state.extras.bench.SPY;
  const s = state.ledger.series;
  const spyYear = y => {
    if (!b) return NaN;
    const idx = s.dates.map((d, i) => [d, b.idx[i]]).filter(([d]) => d.startsWith(y));
    const prev = s.dates.map((d, i) => [d, b.idx[i]]).filter(([d]) => d < y + '-01-01').at(-1);
    const start = prev ? prev[1] : idx[0][1];
    return idx.at(-1)[1] / start - 1;
  };
  $('#tbl-years').innerHTML = `<thead><tr><th>Year</th><th>Portfolio</th><th>S&amp;P 500 (SPY)</th></tr></thead><tbody>${yearly.map(y =>
    `<tr><td>${y.period}${y.period === s.dates[0].slice(0, 4) ? ' (from ' + fmtDate(s.dates[0]).replace(/ \d{4}$/, '') + ')' : ''}${y.period === s.dates.at(-1).slice(0, 4) ? ' to date' : ''}</td><td class="${cls(y.ret)}">${pct(y.ret)}</td><td class="${cls(spyYear(y.period))}">${pct(spyYear(y.period))}</td></tr>`).join('')}</tbody>`;
}
function renderFoot() {
  const { model, cache } = state;
  const updated = Object.values(cache).map(c => c.updated).filter(Boolean).sort().at(-1);
  $('#foot').innerHTML = `<div>Built from ${model.statements.map(s => esc(s.fileName || s.periodStart)).join(', ')}. Figures in ${model.baseCcy}; EUR deposits converted at IBKR's own rates.</div>
    <div>${updated ? `Daily prices updated ${esc(updated.slice(0, 10))}.` : 'No daily price cache found; prices come from your statements.'} ${demo ? 'Demo data is not saved.' : `Your statements are processed only in this browser${EMBED ? '' : ' and kept in its local storage until you choose Forget data'}.`}</div>`;
}

/* ---------- charts ---------- */
function disposeCharts() { Object.values(charts).forEach(c => c.dispose()); charts = {}; }
function chart(id) {
  const el = document.getElementById(id);
  charts[id]?.dispose();
  charts[id] = echarts.init(el, null, { renderer: 'canvas' });
  return charts[id];
}
function base(T, extra = {}) {
  return {
    animation: false,
    textStyle: { fontFamily: T.sans, color: T.ink2 },
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    tooltip: {
      trigger: 'axis', backgroundColor: T.surface, borderColor: T.hair, borderWidth: 1, padding: [8, 10],
      textStyle: { color: T.ink, fontSize: 12, fontFamily: T.sans },
      axisPointer: { type: 'line', lineStyle: { color: T.axis, width: 1 } },
      extraCssText: 'box-shadow:0 6px 20px rgba(0,0,0,.08);border-radius:8px;',
    },
    ...extra,
  };
}
const timeAxis = T => ({
  type: 'time', axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
  axisLabel: { color: T.muted, fontSize: 11, hideOverlap: true, formatter: { month: '{MMM}', year: '{yyyy}', day: '{d} {MMM}' } },
  splitLine: { show: false },
});
const valAxis = (T, fmt) => ({
  type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: T.muted, fontSize: 11, formatter: fmt },
  splitLine: { lineStyle: { color: T.hair, width: 1 } },
});
const kfmt = v => (v < 0 ? '−' : '') + '$' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : nf0.format(Math.abs(v)));
const pfmt = v => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
const legend = (id, items) => { $(id).innerHTML = items.map(([c, t, shape = '']) => `<span><i class="${shape}" style="background:${c};color:${c}"></i>${t}</span>`).join(''); };
const ttRow = (c, name, val) => `<div style="display:flex;gap:10px;justify-content:space-between;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px"></span>${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`;

function rangeStart() {
  const end = state.ledger.endDate;
  const d = new Date(end + 'T00:00:00Z');
  if (range === '3M') d.setUTCMonth(d.getUTCMonth() - 3);
  else if (range === '6M') d.setUTCMonth(d.getUTCMonth() - 6);
  else if (range === '1Y') d.setUTCFullYear(d.getUTCFullYear() - 1);
  else if (range === 'YTD') return end.slice(0, 4) + '-01-01';
  else return state.ledger.startDate;
  return d.toISOString().slice(0, 10);
}

function renderCharts() {
  const T = tokens();
  renderValueChart(T);
  renderTwrChart(T);
  renderMonthly(T);
  renderAlloc(T);
  renderDetailCharts(T);
  renderDivChart(T);
  renderBridge(T);
}

function renderValueChart(T) {
  const s = state.ledger.series, b = state.extras.bench.SPY;
  const nav = s.dates.map((d, i) => [d, s.nav[i]]);
  const dep = s.dates.map((d, i) => [d, s.netDeposits[i]]);
  const depDots = s.dates.map((d, i) => [d, s.netDeposits[i], s.flow[i]]).filter(x => x[2] > 0.5);
  const series = [
    { name: 'Portfolio value', type: 'line', data: nav, showSymbol: false, lineStyle: { width: 2, color: T.s1 }, itemStyle: { color: T.s1 },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: T.s1 + '33' }, { offset: 1, color: T.s1 + '00' }]) }, z: 3 },
    { name: 'Net deposited', type: 'line', step: 'end', data: dep, showSymbol: false, lineStyle: { width: 1.5, color: T.deposit }, itemStyle: { color: T.deposit }, z: 2 },
    { name: 'Deposit', type: 'scatter', data: depDots, symbolSize: 8, itemStyle: { color: T.deposit, borderColor: T.surface, borderWidth: 2 }, z: 4, tooltip: { show: false } },
  ];
  const items = [[T.s1, 'Portfolio value'], [T.deposit, 'Net deposited'], [T.deposit, 'Deposit', 'dot']];
  if (b) {
    series.push({ name: 'Same deposits in S&P 500', type: 'line', data: s.dates.map((d, i) => [d, b.same[i]]), showSymbol: false, lineStyle: { width: 1.5, color: T.s2 }, itemStyle: { color: T.s2 }, z: 2 });
    items.push([T.s2, 'Same deposits in S&P 500 (SPY)']);
  }
  legend('#legend-value', items);
  const c = chart('ch-value');
  c.setOption(base(T, {
    xAxis: { ...timeAxis(T), min: rangeStart(), max: state.ledger.endDate },
    yAxis: valAxis(T, kfmt),
    tooltip: { ...base(T).tooltip, formatter: ps => {
      const i = ps[0].dataIndex, d = s.dates[i];
      const rows = [ttRow(T.s1, 'Value', money(s.nav[i])), ttRow(T.deposit, 'Deposited', money(s.netDeposits[i])),
        ttRow(s.nav[i] - s.netDeposits[i] >= 0 ? T.gain : T.loss, 'Gain', signed(s.nav[i] - s.netDeposits[i]))];
      if (b) rows.push(ttRow(T.s2, 'S&P 500, same deposits', money(b.same[i])));
      if (s.flow[i] > 0.5) rows.push(`<div style="color:${T.muted};margin-top:4px">Deposit ${money(s.flow[i])}</div>`);
      return `<div style="font-weight:600;margin-bottom:4px">${fmtDate(d)}</div>${rows.join('')}`;
    } },
    series,
  }));
  // Rescale y to the visible window.
  const lo = rangeStart();
  const vis = s.dates.map((d, i) => d >= lo ? [s.nav[i], s.netDeposits[i], b ? b.same[i] : s.nav[i]] : null).filter(Boolean).flat();
  const vmin = Math.min(...vis), vmax = Math.max(...vis);
  c.setOption({ yAxis: { min: vmin < vmax * 0.25 ? 0 : Math.floor(vmin * 0.95 / 100) * 100, max: Math.ceil(vmax * 1.03 / 100) * 100 } });
}

function renderTwrChart(T) {
  const s = state.ledger.series, idx = state.kpis.index, bench = state.extras.bench;
  const first = s.nav.findIndex(v => v > 1);
  const pts = (arr) => s.dates.map((d, i) => i >= first ? [d, arr[i] - 1] : null).filter(Boolean);
  const series = [{ name: 'Portfolio', type: 'line', data: pts(idx), showSymbol: false, lineStyle: { width: 2, color: T.s1 }, itemStyle: { color: T.s1 }, z: 3,
    markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: T.axis, width: 1, type: 'solid' }, data: [{ yAxis: 0 }] } }];
  const items = [[T.s1, 'Portfolio (time-weighted)']];
  if (bench.SPY) { series.push({ name: 'S&P 500', type: 'line', data: pts(bench.SPY.idx), showSymbol: false, lineStyle: { width: 1.5, color: T.s2 }, itemStyle: { color: T.s2 } }); items.push([T.s2, 'S&P 500 (SPY, price)']); }
  if (bench.QQQ) { series.push({ name: 'Nasdaq-100', type: 'line', data: pts(bench.QQQ.idx), showSymbol: false, lineStyle: { width: 1.5, color: T.s3 }, itemStyle: { color: T.s3 } }); items.push([T.s3, 'Nasdaq-100 (QQQ, price)']); }
  legend('#legend-twr', items);
  chart('ch-twr').setOption(base(T, {
    xAxis: timeAxis(T), yAxis: valAxis(T, pfmt),
    tooltip: { ...base(T).tooltip, valueFormatter: v => pct(v) },
    series,
  }));
  const { dd } = drawdown(idx.slice(first));
  chart('ch-dd').setOption(base(T, {
    grid: { left: 8, right: 16, top: 18, bottom: 20, containLabel: true },
    title: { text: 'Drawdown from peak', left: 0, top: 0, textStyle: { fontSize: 11, fontWeight: 500, color: T.muted, fontFamily: T.sans } },
    xAxis: { ...timeAxis(T), axisLabel: { show: false } }, yAxis: { ...valAxis(T, pfmt), scale: false, max: 0, splitNumber: 2 },
    tooltip: { ...base(T).tooltip, valueFormatter: v => pct(v) },
    series: [{ name: 'Drawdown', type: 'line', data: s.dates.slice(first).map((d, i) => [d, dd[i]]), showSymbol: false, lineStyle: { width: 1, color: T.loss }, itemStyle: { color: T.loss }, areaStyle: { color: T.loss + '26' } }],
  }));
}

function renderMonthly(T) {
  const m = state.extras.monthly;
  const label = p => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  chart('ch-monthly').setOption(base(T, {
    xAxis: { type: 'category', data: m.map(x => label(x.period)), axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 11, hideOverlap: true } },
    yAxis: valAxis(T, v => (v > 0 ? '+' : '') + (v * 100).toFixed(0) + '%'),
    tooltip: { ...base(T).tooltip, trigger: 'item', formatter: p => `<b>${p.name}</b><br>${pct(p.value, 2)}` },
    series: [{ type: 'bar', barMaxWidth: 22, data: m.map(x => ({ value: x.ret, itemStyle: { color: x.ret >= 0 ? T.gain : T.loss, borderRadius: x.ret >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })) }],
  }));
}

function renderAlloc(T) {
  const open = state.ledger.positions.filter(p => p.open);
  const rows = [...open.map(p => [p.symbol, p.value]), ['Cash', state.kpis.cash]].sort((a, b) => a[1] - b[1]);
  const tot = rows.reduce((a, r) => a + r[1], 0);
  const c = chart('ch-alloc');
  c.setOption(base(T, {
    grid: { left: 8, right: 56, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: 'value', show: false }, yAxis: { type: 'category', data: rows.map(r => r[0]), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.ink, fontWeight: 500, fontSize: 12 } },
    tooltip: { ...base(T).tooltip, trigger: 'item', formatter: p => `<b>${p.name}</b><br>${money(p.value)} · ${(p.value / tot * 100).toFixed(1)}%` },
    series: [{ type: 'bar', barWidth: '60%', data: rows.map(r => ({ value: r[1], itemStyle: { color: r[0] === 'Cash' ? T.other : T.s1, borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', color: T.ink2, fontSize: 11, formatter: p => (p.value / tot * 100).toFixed(1) + '%' } }],
  }));
  c.off('click');
  c.on('click', p => { if (p.name !== 'Cash') selectPosition(p.name, true); });
}

function renderDetailCharts(T = tokens()) {
  const p = state.ledger.positions.find(x => x.symbol === selected);
  if (!p) return;
  const s = state.ledger.series, book = state.book[p.symbol];
  const end = state.ledger.endDate;
  const from = addDays(p.firstDate, -21) < s.dates[0] ? s.dates[0] : addDays(p.firstDate, -21);
  const to = p.open ? end : (addDays(p.lastDate, 30) > end ? end : addDays(p.lastDate, 30));
  const days = s.dates.filter(d => d >= from && d <= to);
  const price = days.map(d => [d, book ? +book.at(d).toFixed(4) : null]);
  const idx0 = s.dates.indexOf(days[0]);
  const avg = days.map((d, k) => { const q = s.qty[idx0 + k][p.symbol]; return [d, q ? s.costs[idx0 + k][p.symbol] / q : null]; });
  const amounts = p.trades.map(t => t.amount);
  const maxAmt = Math.max(...amounts, 1);
  const size = a => 9 + 13 * Math.sqrt(a / maxAmt);
  const mk = side => p.trades.filter(t => t.side === side).map(t => ({ value: [t.date, t.price], t, symbolSize: size(t.amount) }));
  legend('#legend-price', [[T.ink2, book?.source === 'market' ? 'Daily close' : 'Price (from statements)'], [T.muted, 'Average cost', 'dash'], [T.s1, 'Buy', 'tri-up'], [T.s2, 'Sell', 'tri-down']]);
  const tradeTip = t => `<div style="font-weight:600;margin-bottom:4px">${t.side === 'BUY' ? 'Bought' : 'Sold'} ${esc(t.symbol)} · ${fmtDate(t.date)}</div>
    ${ttRow(t.side === 'BUY' ? T.s1 : T.s2, 'Quantity', qtyFmt(Math.abs(t.qty)))}${ttRow(T.ink2, 'Price', money(t.price, 2))}${ttRow(T.ink2, 'Amount', money(t.amount, 2))}
    ${t.side === 'SELL' ? ttRow(t.realizedBase >= 0 ? T.gain : T.loss, 'Realized', signed(t.realizedBase, 2)) : ''}${ttRow(T.muted, 'Position after', qtyFmt(t.qtyAfter))}`;
  chart('ch-price').setOption(base(T, {
    xAxis: timeAxis(T), yAxis: valAxis(T, v => '$' + nf0.format(v)),
    tooltip: { ...base(T).tooltip, formatter: ps => {
      const arr = Array.isArray(ps) ? ps : [ps];
      const tr = arr.find(x => x.data?.t);
      if (tr) return tradeTip(tr.data.t);
      const d = arr[0].value[0];
      const pr = arr.find(x => x.seriesName === 'Price'), ac = arr.find(x => x.seriesName === 'Average cost');
      return `<div style="font-weight:600;margin-bottom:4px">${fmtDate(d)}</div>${pr ? ttRow(T.ink2, 'Price', money(pr.value[1], 2)) : ''}${ac && ac.value[1] ? ttRow(T.muted, 'Average cost', money(ac.value[1], 2)) : ''}`;
    } },
    series: [
      { name: 'Price', type: 'line', data: price, showSymbol: false, lineStyle: { width: 1.5, color: T.ink2 }, itemStyle: { color: T.ink2 }, z: 2 },
      { name: 'Average cost', type: 'line', step: 'end', data: avg, showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, color: T.muted, type: [5, 4] }, itemStyle: { color: T.muted }, z: 1 },
      { name: 'Buy', type: 'scatter', data: mk('BUY'), symbol: 'triangle', itemStyle: { color: T.s1, borderColor: T.surface, borderWidth: 2 }, z: 5, tooltip: { trigger: 'item' } },
      { name: 'Sell', type: 'scatter', data: mk('SELL'), symbol: 'triangle', symbolRotate: 180, itemStyle: { color: T.s2, borderColor: T.surface, borderWidth: 2 }, z: 5, tooltip: { trigger: 'item' } },
    ],
  }));
  const val = days.map((d, k) => [d, s.holdings[idx0 + k][p.symbol] || 0]);
  const cost = days.map((d, k) => [d, s.costs[idx0 + k][p.symbol] || 0]);
  legend('#legend-posval', [[T.s1, 'Market value'], [T.deposit, 'Cost basis']]);
  chart('ch-posval').setOption(base(T, {
    xAxis: timeAxis(T), yAxis: { ...valAxis(T, kfmt), scale: false },
    tooltip: { ...base(T).tooltip, formatter: ps => `<div style="font-weight:600;margin-bottom:4px">${fmtDate(ps[0].value[0])}</div>${ttRow(T.s1, 'Value', money(ps[0].value[1]))}${ttRow(T.deposit, 'Cost', money(ps[1].value[1]))}${ttRow(ps[0].value[1] - ps[1].value[1] >= 0 ? T.gain : T.loss, 'Unrealized', signed(ps[0].value[1] - ps[1].value[1]))}` },
    series: [
      { name: 'Value', type: 'line', data: val, showSymbol: false, lineStyle: { width: 2, color: T.s1 }, itemStyle: { color: T.s1 }, areaStyle: { color: T.s1 + '1f' } },
      { name: 'Cost', type: 'line', step: 'end', data: cost, showSymbol: false, lineStyle: { width: 1.5, color: T.deposit }, itemStyle: { color: T.deposit } },
    ],
  }));
}

function renderDivChart(T) {
  const m = monthlyDividends();
  const label = p => new Date(p + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  chart('ch-divs').setOption(base(T, {
    xAxis: { type: 'category', data: m.map(x => label(x[0])), axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 11, hideOverlap: true } },
    yAxis: { ...valAxis(T, v => '$' + nf0.format(v)), scale: false },
    tooltip: { ...base(T).tooltip, trigger: 'item', formatter: p => `<b>${p.name}</b><br>${money(p.value, 2)} net` },
    series: [{ type: 'bar', barMaxWidth: 22, data: m.map(x => x[1]), itemStyle: { color: T.s1, borderRadius: [4, 4, 0, 0] } }],
  }));
}

function renderBridge(T) {
  const k = state.kpis;
  const price = k.gain - k.dividends - k.tax - k.interest - k.fees - k.commissions;
  const steps = [['Deposited', k.netDeposits, 'total'], ['Price gains', price], ['Dividends', k.dividends], ['Tax withheld', k.tax], ['Trading costs', k.commissions], ['Interest', k.interest + k.fees], ['Value today', k.nav, 'total']];
  let run = 0;
  const baseArr = [], vals = [], colors = [];
  for (const [, v, kind] of steps) {
    if (kind === 'total') { baseArr.push(0); vals.push(v); colors.push(kind && v === k.nav ? T.s1 : T.deposit); run = v; }
    else { const lo = v >= 0 ? run : run + v; baseArr.push(lo); vals.push(Math.abs(v)); colors.push(v >= 0 ? T.gain : T.loss); run += v; }
  }
  chart('ch-bridge').setOption(base(T, {
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: steps.map(s => s[0]), axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false }, axisLabel: { color: T.muted, fontSize: 11, interval: 0, width: 70, overflow: 'break' } },
    yAxis: { ...valAxis(T, kfmt), scale: false },
    tooltip: { ...base(T).tooltip, trigger: 'item', formatter: p => { const st = steps[p.dataIndex]; return `<b>${st[0]}</b><br>${st[2] ? money(st[1], 2) : signed(st[1], 2)}`; } },
    series: [
      { type: 'bar', stack: 'b', data: baseArr, itemStyle: { color: 'transparent' }, tooltip: { show: false }, silent: true },
      { type: 'bar', stack: 'b', barMaxWidth: 36, data: vals.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: 3 } })),
        label: { show: true, position: 'top', color: T.ink2, fontSize: 11, formatter: p => { const st = steps[p.dataIndex]; return st[2] ? kfmt(st[1]) : (st[1] >= 0 ? '+' : '') + kfmt(st[1]); } } },
    ],
  }));
}

/* ---------- boot ---------- */
function initRange() {
  document.querySelectorAll('#range button').forEach(b => b.addEventListener('click', () => {
    range = b.dataset.range;
    document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
    renderValueChart(tokens());
  }));
}
let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => Object.values(charts).forEach(c => c.resize()), 120); });

initTheme();
initIntake();
initRange();
files = EMBED?.files || loadStoredFiles();
if (!EMBED && location.hash === '#demo') loadDemo();
else if (files.length) run();
window.addEventListener('hashchange', () => { if (location.hash === '#demo' && !demo && !EMBED) loadDemo(); });
