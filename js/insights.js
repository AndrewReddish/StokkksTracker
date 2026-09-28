// Look-through exposure, fund overlap, rule-based health checks and rebalancing.
// Pure functions: they take the analysed portfolio plus data/funds.json and return plain objects.

import { usd } from './privacy.js';

export const SECTOR_LABELS = {
  technology: 'Technology', communication: 'Communication', consumer_discretionary: 'Consumer discretionary',
  consumer_staples: 'Consumer staples', financials: 'Financials', healthcare: 'Healthcare', industrials: 'Industrials',
  materials: 'Materials', energy: 'Energy', utilities: 'Utilities', real_estate: 'Real estate', other: 'Other',
  unknown: 'Not classified',
};
export const REGION_LABELS = { us: 'United States', developed: 'Developed ex-US', emerging: 'Emerging markets', unknown: 'Not classified' };
export const ASSET_LABELS = { equity: 'Stocks', bond: 'Bonds', cash: 'Cash', real_estate: 'Real estate', other: 'Other', unknown: 'Not classified' };

// Thresholds for the health checks: rule-of-thumb levels, applied to loaded data only.
export const RULES = {
  positionHigh: 0.20, positionMedium: 0.10, broadFund: 0.40, sectorFund: 0.15, companyLookThrough: 0.10, top3: 0.60, sector: 0.35,
  sectorVsMarket: 1.6, minIntl: 0.20, smallPosition: 0.02, fundOverlap: 0.35, expensiveFund: 0.30, cashDrag: 0.05, smallTrade: 500,
  loser: -0.10, consolidateCap: 0.20, minCoverage: 0.5,
};

const canon = (sym, aliases) => aliases?.[sym] || sym;

export async function loadFunds(base = 'data/') {
  try {
    const res = await fetch(base + 'funds.json', { cache: 'no-cache' });
    if (res.ok) return { ...(await res.json()), loadError: null };
    return { funds: {}, status: {}, aliases: {}, loadError: `funds.json returned HTTP ${res.status}` };
  } catch (e) {
    return { funds: {}, status: {}, aliases: {}, loadError: location.protocol === 'file:' ? 'the page was opened from disk (file://), so the browser blocks loading data files' : e.message };
  }
}

// Sector / region weights of one holding, as {key: fraction} plus the unclassified remainder.
function fundBreakdown(f, field, coverageField) {
  const out = { ...(f?.[field] || {}) };
  const cov = f?.[coverageField] || 0;
  // Coverage is measured against the fund's full holdings list; the rest stays unclassified.
  const total = f?.holdingsWeight || 1;
  const rest = Math.max(0, total - cov) / total;
  const scaled = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / total]));
  if (rest > 0.0005) scaled.unknown = (scaled.unknown || 0) + rest;
  return scaled;
}

export function lookThrough(positions, cash, fundsDb) {
  const funds = fundsDb.funds || {}, aliases = fundsDb.aliases || {};
  const open = positions.filter(p => p.open && p.value > 0);
  const total = open.reduce((a, p) => a + p.value, 0) + Math.max(0, cash);
  const companies = {}, sectors = {}, regions = {}, assets = {};
  if (cash > 0) assets.cash = cash / total;
  const missing = [];
  let erW = 0, erBase = 0, fundW = 0, equityW = 0;
  const addTo = (map, k, w) => { map[k] = (map[k] || 0) + w; };
  const addCompany = (sym, name, w, via) => {
    const k = canon(sym, aliases);
    const c = (companies[k] ||= { symbol: k, name: name || k, total: 0, direct: 0, via: {} });
    if (via) c.via[via] = (c.via[via] || 0) + w; else c.direct += w;
    c.total += w;
  };
  for (const p of open) {
    const w = p.value / total;
    const f = funds[p.symbol];
    if (!f) {
      missing.push(p.symbol);
      addTo(assets, 'unknown', w); addTo(sectors, 'unknown', w); addTo(regions, 'unknown', w);
      addCompany(p.symbol, p.name, w, null);
      continue;
    }
    if (f.kind === 'stock') {
      addTo(assets, 'equity', w);
      addCompany(p.symbol, f.name || p.name, w, null);
      addTo(sectors, f.sector || 'unknown', w);
      addTo(regions, f.region || 'unknown', w);
      equityW += w;
      continue;
    }
    addTo(assets, f.assetClass || 'unknown', w);
    fundW += w;
    for (const h of f.holdings || []) if (h.symbol && h.symbol !== 'n/a') addCompany(h.symbol, h.name, w * h.weight, p.symbol);
    if (f.assetClass === 'equity' || f.assetClass === 'real_estate') {
      for (const [k, v] of Object.entries(fundBreakdown(f, 'sectors', 'sectorCoverage'))) addTo(sectors, k, w * v);
      for (const [k, v] of Object.entries(fundBreakdown(f, 'regions', 'regionCoverage'))) addTo(regions, k, w * v);
      equityW += w;
    } else if (!f.assetClass) {
      // Unknown asset class: count its exposure as unclassified rather than guessing.
      addTo(sectors, 'unknown', w); addTo(regions, 'unknown', w); equityW += w;
    }
    if (isFinite(f.expenseRatio)) { erW += w * f.expenseRatio; erBase += w; }
  }
  const fmt = (map, labels) => Object.entries(map).map(([k, v]) => ({ key: k, label: labels[k] || k, weight: v, ofEquity: equityW ? v / equityW : 0 }))
    .sort((a, b) => (a.key === 'unknown') - (b.key === 'unknown') || b.weight - a.weight);
  const sectorList = fmt(sectors, SECTOR_LABELS), regionList = fmt(regions, REGION_LABELS);
  return {
    total,
    companies: Object.values(companies).sort((a, b) => b.total - a.total),
    sectors: sectorList, regions: regionList, assets: fmt(assets, ASSET_LABELS),
    sectorUnknown: sectors.unknown ? sectors.unknown / (equityW || 1) : 0,
    regionUnknown: regions.unknown ? regions.unknown / (equityW || 1) : 0,
    missing, fundExpenseRatio: erBase ? erW / erBase : NaN, erCoverage: fundW ? erBase / fundW : 0,
    marketSectors: benchmarkSectors(funds), fundsDb,
  };
}

function benchmarkSectors(funds) {
  const f = funds.SPY || funds.VOO;
  if (!f?.sectors || (f.sectorCoverage || 0) < 0.9) return null;
  const s = Object.values(f.sectors).reduce((a, x) => a + x, 0);
  return { weights: Object.fromEntries(Object.entries(f.sectors).map(([k, v]) => [k, v / s])), source: `${f === funds.SPY ? 'SPY' : 'VOO'} holdings (${f.sectorSource || f.source}, ${f.asOf})` };
}

// Overlap between two funds: the weight they share, measured on their loaded holdings.
export function fundOverlaps(positions, fundsDb) {
  const funds = fundsDb.funds || {}, aliases = fundsDb.aliases || {};
  const held = positions.filter(p => p.open && funds[p.symbol]?.kind === 'etf' && funds[p.symbol].holdings?.length).map(p => p.symbol);
  const stocks = positions.filter(p => p.open && funds[p.symbol]?.kind === 'stock').map(p => canon(p.symbol, aliases));
  const pairs = [];
  for (let i = 0; i < held.length; i++) for (let j = i + 1; j < held.length; j++) {
    const a = funds[held[i]], b = funds[held[j]];
    const wb = new Map(b.holdings.filter(h => h.symbol && h.symbol !== 'n/a').map(h => [canon(h.symbol, aliases), h.weight]));
    const shared = a.holdings.filter(h => h.symbol && h.symbol !== 'n/a').map(h => [canon(h.symbol, aliases), Math.min(h.weight, wb.get(canon(h.symbol, aliases)) || 0)]).filter(([, w]) => w > 0);
    const overlap = shared.reduce((x, [, w]) => x + w, 0);
    // What share of each fund we can actually see; overlap outside it is unknown.
    const seen = Math.min(a.storedWeight ?? 1, b.storedWeight ?? 1);
    const complete = (a.storedWeight ?? 0) > 0.97 && (b.storedWeight ?? 0) > 0.97;
    pairs.push({ a: held[i], b: held[j], overlap, seen, complete, duplicate: complete && overlap >= 0.9,
      basis: shared.length ? `shared holdings: ${shared.sort((x, y) => y[1] - x[1]).slice(0, 4).map(([s]) => s).join(', ')}` : 'no shared holdings in the loaded lists' });
  }
  const doubled = [];
  for (const s of stocks) for (const fsym of held) {
    const h = funds[fsym].holdings.find(x => canon(x.symbol, aliases) === s);
    if (h) doubled.push({ stock: s, fund: fsym, weightInFund: h.weight });
  }
  return { funds: held, pairs: pairs.sort((x, y) => y.overlap - x.overlap), doubled };
}

// Rule-based checkup. Each finding: {id, severity: high|medium|low|good, title, detail, metric?}
export function healthChecks({ kpis, ledger, look, overlaps, bench }) {
  const out = [];
  const add = (severity, id, title, detail) => out.push({ severity, id, title, detail });
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const open = ledger.positions.filter(p => p.open).sort((a, b) => b.value - a.value);
  const tot = look.total;
  const funds = look.fundsDb?.funds || {};

  // Single stocks and single-sector funds carry their own risk; broad funds only when very large.
  for (const p of open) {
    const w = p.value / tot, f = funds[p.symbol];
    const oneSector = f?.kind === 'etf' && (f.sectorCoverage || 0) >= 0.9 && Object.keys(f.sectors || {}).length === 1;
    if (f?.kind === 'stock') {
      if (w >= RULES.positionMedium) add(w >= RULES.positionHigh ? 'high' : 'medium', 'position-' + p.symbol, `${p.symbol} is ${pct(w)} of the portfolio`,
        `A single company above ${pct(RULES.positionMedium)} means one earnings miss or scandal moves your whole portfolio. Check that this weight is intentional.`);
    } else if (oneSector && w >= RULES.sectorFund) {
      add('medium', 'position-' + p.symbol, `${p.symbol} (one sector) is ${pct(w)} of the portfolio`, `All of its classified holdings are in ${SECTOR_LABELS[Object.keys(f.sectors)[0]]}.`);
    } else if (f?.kind === 'etf' && w >= RULES.broadFund) {
      add('low', 'position-' + p.symbol, `${p.symbol} is ${pct(w)} of the portfolio`, 'It is diversified internally, but your results depend heavily on this one fund.');
    }
  }
  const top3 = open.slice(0, 3).reduce((a, p) => a + p.value, 0) / tot;
  if (top3 > RULES.top3) add('medium', 'top3', `Top 3 holdings make up ${pct(top3)}`, `${open.slice(0, 3).map(p => p.symbol).join(', ')} together exceed ${pct(RULES.top3)} of the portfolio.`);

  for (const c of look.companies.filter(c => c.total >= RULES.companyLookThrough && Object.keys(c.via).length)) {
    add('high', 'company-' + c.symbol, `${c.symbol} exposure is ${pct(c.total)} once funds are looked through`,
      `${pct(c.direct)} direct plus ${Object.entries(c.via).map(([f, w]) => `${pct(w)} via ${f}`).join(', ')}.`);
  }
  const hidden = look.companies.filter(c => c.direct > 0 && Object.keys(c.via).length && c.total < RULES.companyLookThrough && c.total > 0.02);
  if (hidden.length) add('low', 'hidden-doubles', `${hidden.length} stock${hidden.length > 1 ? 's' : ''} you own directly also sit${hidden.length > 1 ? '' : 's'} inside your funds`,
    hidden.map(c => `${c.symbol} ${pct(c.direct)} direct + ${pct(c.total - c.direct)} via ${Object.keys(c.via).join('/')}`).join('; ') + '. Not a problem by itself, but the real weight is higher than the position size suggests.');

  // Sector checks use only classified holdings, and only when enough of the portfolio is classified.
  const classified = look.sectors.filter(s => s.key !== 'unknown');
  const sectorShare = classified.reduce((a, s) => a + s.ofEquity, 0);
  const mk = look.marketSectors?.weights;
  if (sectorShare < RULES.minCoverage) {
    add('low', 'sector-skip', 'Sector checks skipped', `Only ${pct(sectorShare)} of your stock holdings have a loaded sector classification. See Data status.`);
  } else {
    for (const s of classified) {
      const share = s.ofEquity;
      const m = mk?.[s.key];
      if (share >= RULES.sector) add('medium', 'sector-' + s.key, `${s.label} is ${pct(share)} of your stock holdings`, `Heavy tilt to one sector${m != null ? ` (S&P 500: ${pct(m)})` : ''}. A sector drawdown would hit you hard.`);
      else if (m > 0.03 && share > m * RULES.sectorVsMarket && share > 0.12) add('low', 'sectorTilt-' + s.key, `Overweight ${s.label}: ${pct(share)} vs ${pct(m)} in the S&P 500`, 'A deliberate tilt is fine; an accidental one usually comes from stacking similar funds and stocks.');
    }
    if (mk && sectorShare > 0.9) {
      const gaps = Object.entries(mk).filter(([k, m]) => m >= 0.05 && !((look.sectors.find(s => s.key === k)?.ofEquity || 0) > m * 0.3));
      if (gaps.length) add('low', 'sector-gaps', `Little exposure to ${gaps.map(([k]) => SECTOR_LABELS[k] || k).join(', ')}`, 'Each is at least 5% of the S&P 500 but under a third of that weight in your stock holdings.');
    }
  }

  const regionKnown = look.regions.filter(r => r.key !== 'unknown');
  const regionShare = regionKnown.reduce((a, r) => a + r.ofEquity, 0);
  if (regionShare >= RULES.minCoverage) {
    const intl = regionKnown.filter(r => r.key !== 'us').reduce((a, r) => a + r.ofEquity, 0) / regionShare;
    const note = regionShare < 0.97 ? ` (of the ${pct(regionShare)} of stock holdings with a known country)` : '';
    if (intl < RULES.minIntl) add('medium', 'intl', `Only ${pct(intl)} of your stocks are outside the US${note}`, 'Most of your equity risk sits in one country. A fund of non-US stocks alongside your US holdings spreads it.');
    else add('good', 'intl', `${pct(intl)} of your stocks are outside the US${note}`, 'Your stock holdings are spread across countries.');
  } else {
    add('low', 'region-skip', 'Region check skipped', `Only ${pct(regionShare)} of your stock holdings have a known country. See Data status.`);
  }
  const assetUnknown = look.assets.find(a => a.key === 'unknown')?.weight || 0;
  if (assetUnknown < RULES.minCoverage) {
    const bonds = look.assets.filter(a => a.key === 'bond' || a.key === 'cash').reduce((a, x) => a + x.weight, 0);
    add(bonds < 0.05 ? 'low' : 'good', 'defensive', bonds < 0.05 ? 'Almost no bonds or cash buffer' : `${pct(bonds)} in bonds and cash`,
      bonds < 0.05 ? 'Fine for a long horizon and steady deposits; if you may need the money within a few years, a bond or T-bill holding dampens drawdowns.' : 'Provides a buffer for drawdowns and rebalancing.');
  }

  for (const p of overlaps.pairs.filter(p => p.duplicate)) add('high', 'dup-' + p.a + p.b, `${p.a} and ${p.b} hold almost the same thing`, `${pct(p.overlap)} of their holdings are shared (${p.basis}). Keeping one saves orders and simplifies.`);
  for (const p of overlaps.pairs.filter(p => !p.duplicate && p.overlap >= RULES.fundOverlap)) add('medium', 'overlap-' + p.a + p.b, `${p.a} and ${p.b} share at least ${pct(p.overlap)} of their holdings`,
    `Measured on the holdings loaded for both (${p.complete ? 'full lists' : `the loaded lists cover ${pct(p.seen)} of the smaller one`}); ${p.basis}.`);

  const small = open.filter(p => p.value / tot < RULES.smallPosition);
  if (small.length >= 2) add('low', 'small', `${small.length} positions are under ${pct(RULES.smallPosition)} each`, `${small.map(p => p.symbol).join(', ')}. Small positions barely move results but add orders, tracking and tax paperwork.`);

  if (isFinite(look.fundExpenseRatio)) {
    const pricey = open.filter(p => (funds[p.symbol]?.expenseRatio || 0) >= RULES.expensiveFund);
    const cov = look.erCoverage < 0.999 ? ` (fees loaded for ${pct(look.erCoverage)} of your fund holdings)` : ' across your funds';
    add(pricey.length ? 'low' : 'good', 'fees', `Weighted fund fee ${look.fundExpenseRatio.toFixed(2)}% a year${cov}`,
      pricey.length ? `${pricey.map(p => `${p.symbol} (${funds[p.symbol].expenseRatio}%)`).join(', ')} cost ${RULES.expensiveFund}% or more a year.` : `No fund costs ${RULES.expensiveFund}% or more a year.`);
  }
  const buys = ledger.positions.flatMap(p => p.trades.filter(t => t.side === 'BUY'));
  if (buys.length) {
    const avgBuy = buys.reduce((a, t) => a + t.amount, 0) / buys.length;
    const costPct = buys.reduce((a, t) => a - t.comm, 0) / buys.reduce((a, t) => a + t.amount, 0);
    if (avgBuy < RULES.smallTrade) add('medium', 'trade-size', `Average buy is ${usd(avgBuy)}; commissions took ${(costPct * 100).toFixed(2)}% of it`, 'From your statements. Fewer, larger orders spread the per-order minimum over more money.');
    else add('good', 'trade-size', `Commissions were ${(costPct * 100).toFixed(2)}% of the amount bought`, `From your statements; average buy ${usd(avgBuy)}.`);
  }
  const quick = ledger.positions.filter(p => !p.open && p.holdingDays < 90).length;
  if (quick >= 3) add('low', 'churn', `${quick} positions were bought and fully sold within 90 days`, 'Short holding periods raise costs and, in most countries, taxes on gains.');

  const cashW = Math.max(0, kpis.cash) / tot;
  if (cashW > RULES.cashDrag) add('low', 'cash', `${pct(cashW)} sits in uninvested cash`, 'Invest it, or hold it in a T-bill fund if it is a deliberate reserve.');

  for (const p of open.filter(p => p.costBasis && p.unrealized / p.costBasis <= RULES.loser)) {
    add('low', 'loser-' + p.symbol, `${p.symbol} is ${pct(-p.unrealized / p.costBasis)} below cost`, `Unrealized ${usd(p.unrealized)}. Re-check the reason for owning it rather than anchoring on the purchase price.`);
  }
  if (bench && isFinite(bench.diff)) {
    add(bench.diff >= 0 ? 'good' : 'medium', 'vs-index', bench.diff >= 0 ? `Ahead of the S&P 500 by ${usd(bench.diff)}` : `Behind the S&P 500 by ${usd(-bench.diff)}`,
      `The same deposits on the same days into SPY would be worth ${usd(bench.value)} (SPY price only, dividends excluded).`);
  }
  if (look.missing.length) add('low', 'unclassified', `No classification data for ${look.missing.join(', ')}`, 'They count as "Not classified" in every breakdown. See Data status.');
  const order = { high: 0, medium: 1, low: 2, good: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ---------- rebalancing ---------- */

// Target presets: {symbol: weight} over invested assets (cash handled separately).
export function presetTargets(kind, positions, total) {
  const open = positions.filter(p => p.open && p.value > 0);
  const inv = open.reduce((a, p) => a + p.value, 0);
  if (kind === 'equal') return Object.fromEntries(open.map(p => [p.symbol, 1 / open.length]));
  if (kind === 'consolidate') {
    // Drop positions under 2%, cap each at 20%, spread the rest proportionally.
    let keep = open.filter(p => p.value / total >= RULES.smallPosition);
    let w = Object.fromEntries(keep.map(p => [p.symbol, p.value]));
    const cap = RULES.consolidateCap;
    for (let iter = 0; iter < 10; iter++) {
      const s = Object.values(w).reduce((a, x) => a + x, 0);
      let excess = 0, free = 0;
      for (const k in w) { const x = w[k] / s; if (x > cap) excess += x - cap; else free += x; }
      if (excess < 1e-6) break;
      for (const k in w) { const x = w[k] / s; w[k] = x > cap ? cap : x + excess * x / free; }
    }
    const s = Object.values(w).reduce((a, x) => a + x, 0);
    return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / s]));
  }
  return Object.fromEntries(open.map(p => [p.symbol, p.value / inv]));
}

// Full rebalance: sells first, then buys with the proceeds plus new money.
export function rebalancePlan({ positions, cash, targets, prices, newMoney = 0, cashTarget = 0, minTrade = 50, fractional = false, asOf }) {
  // Values are qty x the last observed close. Commissions and taxes are not included.
  const bySym = Object.fromEntries(positions.filter(p => p.open).map(p => [p.symbol, p]));
  const invested = Object.values(bySym).reduce((a, p) => a + p.value, 0);
  const total = invested + cash + newMoney;
  const tsum = Object.values(targets).reduce((a, x) => a + (x > 0 ? x : 0), 0) || 1;
  const investable = total * (1 - cashTarget);
  const syms = [...new Set([...Object.keys(bySym), ...Object.keys(targets)])];
  const rows = syms.map(sym => {
    const p = bySym[sym];
    const price = p?.price ?? prices[sym];
    const cur = p?.value || 0;
    const tw = (targets[sym] > 0 ? targets[sym] : 0) / tsum;
    const target = investable * tw;
    let delta = target - cur;
    let qty = isFinite(price) && price > 0 ? delta / price : NaN;
    if (!fractional) qty = qty > 0 ? Math.floor(qty) : Math.ceil(qty);
    if (p && qty < 0 && -qty > p.qty - 1e-9) qty = -p.qty; // never sell more than held
    if (p && target === 0) qty = -p.qty;
    const value = qty * price;
    return { symbol: sym, name: p?.name || sym, price, current: cur, currentW: cur / total, targetW: tw * (1 - cashTarget), target, qty, value, avgCost: p?.avgCost, heldDays: p?.holdingDays, firstDate: p?.firstDate };
  });
  const trades = [];
  let cashAfter = cash + newMoney;
  for (const r of rows.filter(r => r.qty < 0 && (Math.abs(r.value) >= minTrade || r.target === 0))) {
    const t = { side: 'SELL', symbol: r.symbol, qty: -r.qty, price: r.price, value: -r.value };
    cashAfter += t.value;
    trades.push(t);
  }
  const buys = rows.filter(r => r.qty > 0 && r.value >= minTrade).sort((a, b) => b.value - a.value);
  const need = buys.reduce((a, r) => a + r.value, 0);
  const spendable = cashAfter - total * cashTarget;
  const scale = need > spendable && need > 0 ? Math.max(0, spendable) / need : 1;
  for (const r of buys) {
    let qty = r.qty * scale;
    if (!fractional) qty = Math.floor(qty);
    if (qty <= 0) continue;
    const t = { side: 'BUY', symbol: r.symbol, qty, price: r.price, value: qty * r.price };
    cashAfter -= t.value;
    trades.push(t);
  }
  // Whole shares leave cash over: top up the most underweight names one share at a time.
  if (!fractional) {
    const floor = total * cashTarget;
    for (let guard = 0; guard < 500; guard++) {
      const cands = rows.filter(r => isFinite(r.price) && r.price > 0 && r.target > 0).map(r => {
        const tr = trades.find(t => t.symbol === r.symbol);
        const bought = tr ? (tr.side === 'BUY' ? tr.value : -tr.value) : 0;
        return { r, tr, gap: r.target - (r.current + bought) };
      }).filter(c => c.gap > c.r.price * 0.5 && (!c.tr || c.tr.side === 'BUY') && cashAfter - floor >= c.r.price);
      if (!cands.length) break;
      const c = cands.sort((a, b) => b.gap / b.r.target - a.gap / a.r.target)[0];
      if (c.tr) { c.tr.qty += 1; c.tr.value += c.r.price; }
      else trades.push({ side: 'BUY', symbol: c.r.symbol, qty: 1, price: c.r.price, value: c.r.price });
      cashAfter -= c.r.price;
    }
  }
  const after = rows.map(r => {
    const tr = trades.find(t => t.symbol === r.symbol);
    const v = r.current + (tr ? (tr.side === 'BUY' ? tr.value : -tr.value) : 0);
    return { ...r, after: v };
  });
  const totalAfter = after.reduce((a, r) => a + r.after, 0) + cashAfter;
  for (const r of after) r.afterW = r.after / totalAfter;
  return {
    rows: after.sort((a, b) => b.targetW - a.targetW || b.current - a.current), trades, cashAfter, total,
    summary: {
      sells: trades.filter(t => t.side === 'SELL').reduce((a, t) => a + t.value, 0),
      buys: trades.filter(t => t.side === 'BUY').reduce((a, t) => a + t.value, 0),
      drift: rows.reduce((a, r) => a + Math.abs(r.currentW - r.targetW), 0) / 2,
    },
    asOf,
  };
}

/* ---------- AI review payload ---------- */
export function aiPayload({ model, kpis, ledger, look, overlaps, checks, plan, goals }) {
  const r = (x, n = 4) => (isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);
  const open = ledger.positions.filter(p => p.open);
  return {
    period: { start: ledger.startDate, end: ledger.endDate, baseCurrency: model.baseCcy },
    investorGoals: goals || null,
    totals: {
      value: r(kpis.nav, 0), netDeposits: r(kpis.netDeposits, 0), totalGain: r(kpis.gain, 0), timeWeightedReturn: r(kpis.twr), moneyWeightedIRR: r(kpis.xirr),
      maxDrawdown: r(kpis.maxDD), dividendsNet: r(kpis.dividends + kpis.tax, 0), commissions: r(-kpis.commissions, 0), cash: r(kpis.cash, 0), trades: kpis.tradeCount,
      // Paid outside the account and already subtracted from totalGain and both returns.
      depositCommissionOutsideIbkr: r(kpis.depositFees || 0, 0), taxPaidOutsideIbkr: r(kpis.taxPaid || 0, 0),
    },
    holdings: open.map(p => ({ symbol: p.symbol, name: p.name, type: p.type, weight: r(p.value / look.total), value: r(p.value, 0), unrealizedPct: r(p.costBasis ? p.unrealized / p.costBasis : null), totalReturnUsd: r(p.total, 0), heldDays: p.holdingDays })),
    closedPositions: ledger.positions.filter(p => !p.open).map(p => ({ symbol: p.symbol, totalReturnUsd: r(p.total, 0), returnPct: r(p.returnOnCapital), heldDays: p.holdingDays })),
    lookThrough: {
      sectorsOfStockHoldings: look.sectors.map(s => ({ sector: s.label, share: r(s.ofEquity), sp500: look.marketSectors ? r(look.marketSectors.weights[s.key] || 0) : null })),
      regionsOfEquity: look.regions.map(x => ({ region: x.label, share: r(x.ofEquity) })),
      assetClasses: look.assets.map(a => ({ assetClass: a.label, weight: r(a.weight) })),
      topCompanies: look.companies.slice(0, 15).map(c => ({ symbol: c.symbol, total: r(c.total), direct: r(c.direct), viaFunds: Object.fromEntries(Object.entries(c.via).map(([k, v]) => [k, r(v)])) })),
      weightedFundExpenseRatioPct: r(look.fundExpenseRatio, 3),
      notClassified: look.missing,
    },
    fundOverlaps: overlaps.pairs.filter(p => p.overlap > 0.05).map(p => ({ funds: [p.a, p.b], overlap: r(p.overlap, 2), basis: p.basis })),
    ruleBasedFindings: checks.map(c => ({ severity: c.severity, finding: c.title })),
    currentRebalanceTarget: plan ? plan.rows.map(x => ({ symbol: x.symbol, currentWeight: r(x.currentW), targetWeight: r(x.targetW) })) : null,
  };
}

export const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'strengths', 'issues', 'actions', 'questions'],
  properties: {
    summary: { type: 'string', description: 'Two to four sentences: the overall verdict on this portfolio.' },
    strengths: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['severity', 'title', 'detail'],
        properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['action', 'symbols', 'rationale'],
        properties: {
          action: { type: 'string', enum: ['buy', 'add', 'hold', 'trim', 'sell', 'replace', 'consolidate', 'other'] },
          symbols: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions the investor should answer to refine the plan.' },
  },
};

export const AI_SYSTEM = `You review personal investment portfolios for a private investor. You receive a JSON summary of an Interactive Brokers cash account: holdings with weights, look-through sector/region/company exposure, fund overlaps, performance, costs, and the findings of a simple rule engine. Entries labelled "Not classified" are holdings with no loaded data; treat them as unknown, not as zero.

Give a candid, specific review: name tickers and numbers from the data, explain why each issue matters, and propose concrete, proportionate actions (e.g. "fold SPY into VOO", "direct the next two deposits to VXUS"). Prefer low-cost, diversified, tax-aware moves; favour using new deposits over selling when that achieves the same goal. Do not invent data that is not in the summary; say when something depends on the investor's goals, horizon or tax residence. This is educational analysis, not personalised financial advice; do not add boilerplate disclaimers beyond one short clause in the summary.`;
