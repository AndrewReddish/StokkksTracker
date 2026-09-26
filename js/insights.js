// Look-through exposure, fund overlap, rule-based health checks and rebalancing.
// Pure functions: they take the analysed portfolio plus data/funds.json and return plain objects.

export const SECTOR_LABELS = {
  technology: 'Technology', communication_services: 'Communication', consumer_cyclical: 'Consumer cyclical',
  consumer_defensive: 'Consumer staples', financial_services: 'Financials', healthcare: 'Healthcare',
  industrials: 'Industrials', basic_materials: 'Materials', energy: 'Energy', utilities: 'Utilities', realestate: 'Real estate',
};
export const REGION_LABELS = { us: 'United States', developed: 'Developed ex-US', emerging: 'Emerging markets' };
export const ASSET_LABELS = { equity: 'Stocks', bond: 'Bonds', cash: 'Cash & T-bills', unknown: 'Unclassified' };

// Thresholds for the health checks. Deliberately conservative, rule-of-thumb levels.
export const RULES = {
  positionHigh: 0.20, positionMedium: 0.10, broadFund: 0.40, sectorFund: 0.15, companyLookThrough: 0.10, top3: 0.60, sector: 0.35,
  sectorVsMarket: 1.6, minIntl: 0.20, smallPosition: 0.02, fundOverlap: 0.35, expensiveFund: 0.30,
  cashDrag: 0.05, smallTrade: 500, loser: -0.10, consolidateCap: 0.20,
};

const canon = (sym, aliases) => aliases?.[sym] || sym;

export async function loadFunds(base = 'data/') {
  try {
    const res = await fetch(base + 'funds.json', { cache: 'no-cache' });
    if (res.ok) return await res.json();
  } catch { /* offline or file:// */ }
  return { funds: {}, aliases: {} };
}

export function lookThrough(positions, cash, fundsDb) {
  const funds = fundsDb.funds || {}, aliases = fundsDb.aliases || {};
  const open = positions.filter(p => p.open && p.value > 0);
  const total = open.reduce((a, p) => a + p.value, 0) + Math.max(0, cash);
  const companies = {}, sectors = {}, regions = {}, assets = { cash: Math.max(0, cash) / total };
  const unknown = [];
  let covered = 0, weightedEr = 0, erBase = 0;
  const addCompany = (sym, name, w, via) => {
    const k = canon(sym, aliases);
    const c = (companies[k] ||= { symbol: k, name: name || k, total: 0, direct: 0, via: {} });
    if (via) c.via[via] = (c.via[via] || 0) + w; else c.direct += w;
    c.total += w;
    if (name && c.name === k) c.name = name;
  };
  for (const p of open) {
    const w = p.value / total;
    const f = funds[p.symbol];
    if (!f) {
      unknown.push(p.symbol);
      assets.unknown = (assets.unknown || 0) + w;
      addCompany(p.symbol, p.name, w, null);
      continue;
    }
    assets[f.assetClass] = (assets[f.assetClass] || 0) + w;
    for (const [r, x] of Object.entries(f.region || {})) if (f.assetClass === 'equity') regions[r] = (regions[r] || 0) + w * x;
    if (f.kind === 'stock') {
      addCompany(p.symbol, f.name, w, null);
      if (f.sector) sectors[f.sector] = (sectors[f.sector] || 0) + w;
      covered += w;
    } else {
      for (const h of f.holdings || []) addCompany(h.symbol, h.name, w * h.weight, p.symbol);
      const sw = Object.values(f.sectors || {}).reduce((a, x) => a + x, 0);
      if (sw > 0) for (const [s, x] of Object.entries(f.sectors)) sectors[s] = (sectors[s] || 0) + w * x / sw;
      covered += w;
      if (isFinite(f.expenseRatio)) { weightedEr += w * f.expenseRatio; erBase += w; }
    }
  }
  const equity = Object.values(regions).reduce((a, x) => a + x, 0);
  return {
    total,
    companies: Object.values(companies).sort((a, b) => b.total - a.total),
    sectors: Object.entries(sectors).map(([k, v]) => ({ key: k, label: SECTOR_LABELS[k] || k, weight: v })).sort((a, b) => b.weight - a.weight),
    regions: Object.entries(regions).map(([k, v]) => ({ key: k, label: REGION_LABELS[k] || k, weight: v, ofEquity: equity ? v / equity : 0 })).sort((a, b) => b.weight - a.weight),
    assets: Object.entries(assets).filter(([, v]) => v > 1e-6).map(([k, v]) => ({ key: k, label: ASSET_LABELS[k] || k, weight: v })).sort((a, b) => b.weight - a.weight),
    unknown, coverage: covered, fundExpenseRatio: erBase ? weightedEr / erBase : NaN, fundShare: erBase,
    marketSectors: benchmarkSectors(funds), fundsDb,
  };
}

function benchmarkSectors(funds) {
  const f = funds.SPY || funds.VOO;
  if (!f?.sectors) return {};
  const s = Object.values(f.sectors).reduce((a, x) => a + x, 0);
  return Object.fromEntries(Object.entries(f.sectors).map(([k, v]) => [k, v / s]));
}

// Overlap between two funds: shared weight in their disclosed top holdings, or 100% for the same index.
export function fundOverlaps(positions, fundsDb) {
  const funds = fundsDb.funds || {}, aliases = fundsDb.aliases || {};
  const held = positions.filter(p => p.open && funds[p.symbol]?.kind === 'etf').map(p => p.symbol);
  const stocks = positions.filter(p => p.open && funds[p.symbol]?.kind === 'stock').map(p => canon(p.symbol, aliases));
  const pairs = [];
  for (let i = 0; i < held.length; i++) for (let j = i + 1; j < held.length; j++) {
    const a = funds[held[i]], b = funds[held[j]];
    let overlap, basis;
    if (a.index && a.index === b.index) { overlap = 1; basis = `both track the ${a.index}`; }
    else {
      const wb = new Map((b.holdings || []).map(h => [canon(h.symbol, aliases), h.weight]));
      const shared = (a.holdings || []).map(h => [canon(h.symbol, aliases), Math.min(h.weight, wb.get(canon(h.symbol, aliases)) || 0)]).filter(([, w]) => w > 0);
      overlap = shared.reduce((x, [, w]) => x + w, 0);
      basis = shared.length ? `shared top holdings: ${shared.sort((x, y) => y[1] - x[1]).slice(0, 4).map(([s]) => s).join(', ')}` : 'no shared top holdings';
      // Same sector-only funds overlap heavily even without disclosed holdings.
      const sa = a.sectors || {}, sb = b.sectors || {};
      const sectorSim = Object.keys(sa).reduce((x, k) => x + Math.min(sa[k] || 0, sb[k] || 0), 0);
      if (!a.holdings?.length || !b.holdings?.length) { overlap = Math.max(overlap, sectorSim * 0.5); basis += `; sector similarity ${Math.round(sectorSim * 100)}%`; }
    }
    pairs.push({ a: held[i], b: held[j], overlap, basis, duplicate: overlap >= 0.99 });
  }
  // Stocks you hold directly that also sit inside a fund you hold.
  const doubled = [];
  for (const s of stocks) for (const fsym of held) {
    const h = (funds[fsym].holdings || []).find(x => canon(x.symbol, aliases) === s);
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

  // Single stocks and narrow sector funds carry their own risk; broad index funds only when very large.
  for (const p of open) {
    const w = p.value / tot, f = look.fundsDb?.funds?.[p.symbol];
    const narrow = f?.kind === 'etf' && Object.keys(f.sectors || {}).length === 1;
    if (!f || f.kind === 'stock') {
      if (w >= RULES.positionMedium) add(w >= RULES.positionHigh ? 'high' : 'medium', 'position-' + p.symbol, `${p.symbol} is ${pct(w)} of the portfolio`,
        `A single company above ${pct(RULES.positionMedium)} means one earnings miss or scandal moves your whole portfolio. Check that this weight is intentional.`);
    } else if (narrow && w >= RULES.sectorFund) {
      add('medium', 'position-' + p.symbol, `${p.symbol} (one sector) is ${pct(w)} of the portfolio`, `${f.style || 'A sector fund'} concentrates risk in one industry.`);
    } else if (f.assetClass === 'equity' && w >= RULES.broadFund) {
      add('low', 'position-' + p.symbol, `${p.symbol} is ${pct(w)} of the portfolio`, `It is diversified internally, but your results depend heavily on its ${f.style || 'strategy'}.`);
    }
  }
  const top3 = open.slice(0, 3).reduce((a, p) => a + p.value, 0) / tot;
  if (top3 > RULES.top3) add('medium', 'top3', `Top 3 holdings make up ${pct(top3)}`, `${open.slice(0, 3).map(p => p.symbol).join(', ')} together exceed ${pct(RULES.top3)} of the portfolio.`);

  for (const c of look.companies.filter(c => c.total >= RULES.companyLookThrough && Object.keys(c.via).length)) {
    add('high', 'company-' + c.symbol, `${c.symbol} exposure is ${pct(c.total)} once funds are looked through`,
      `${pct(c.direct)} direct plus ${Object.entries(c.via).map(([f, w]) => `${pct(w)} via ${f}`).join(', ')}.`);
  }
  const hidden = look.companies.filter(c => c.direct > 0 && Object.keys(c.via).length && c.total < RULES.companyLookThrough && c.total > 0.02);
  if (hidden.length) add('low', 'hidden-doubles', `${hidden.length} stock${hidden.length > 1 ? 's' : ''} you own directly also sit inside your funds`,
    hidden.map(c => `${c.symbol} ${pct(c.direct)} direct + ${pct(c.total - c.direct)} via ${Object.keys(c.via).join('/')}`).join('; ') + '. Not a problem by itself, but the real weight is higher than the position size suggests.');

  for (const s of look.sectors) {
    const m = look.marketSectors[s.key] || 0;
    if (s.weight >= RULES.sector) add('medium', 'sector-' + s.key, `${s.label} is ${pct(s.weight)} of the portfolio`, `Heavy tilt to one sector (S&P 500: ${pct(m)}). Sector drawdowns would hit you hard.`);
    else if (m > 0.03 && s.weight > m * RULES.sectorVsMarket && s.weight > 0.12) add('low', 'sectorTilt-' + s.key, `Overweight ${s.label}: ${pct(s.weight)} vs ${pct(m)} in the S&P 500`, 'A deliberate tilt is fine; an accidental one usually comes from stacking similar funds and stocks.');
  }
  const missing = Object.entries(look.marketSectors).filter(([k, m]) => m >= 0.05 && !(look.sectors.find(s => s.key === k)?.weight > m * 0.3));
  if (missing.length) add('low', 'sector-gaps', `Little exposure to ${missing.map(([k]) => SECTOR_LABELS[k]).join(', ')}`, `Each is at least 5% of the US market but under a third of that weight in your portfolio.`);

  const intl = look.regions.filter(r => r.key !== 'us').reduce((a, r) => a + r.ofEquity, 0);
  if (look.regions.length) {
    if (intl < RULES.minIntl) add('medium', 'intl', `Only ${pct(intl)} of your stocks are outside the US`, 'Non-US markets are roughly 35–40% of world stock value. A global core fund (e.g. VXUS alongside a US fund) reduces single-country risk.');
    else add('good', 'intl', `${pct(intl)} of your stocks are outside the US`, 'Geographic diversification is in a reasonable range.');
  }
  const bonds = look.assets.filter(a => a.key === 'bond' || a.key === 'cash').reduce((a, x) => a + x.weight, 0);
  add(bonds < 0.05 ? 'low' : 'good', 'defensive', bonds < 0.05 ? 'Almost no bonds or cash buffer' : `${pct(bonds)} in bonds and cash`,
    bonds < 0.05 ? 'Fine for a long horizon and steady deposits; if you may need the money within a few years, a bond or T-bill sleeve dampens drawdowns.' : 'Provides a buffer for drawdowns and rebalancing.');

  for (const p of overlaps.pairs.filter(p => p.duplicate)) add('high', 'dup-' + p.a + p.b, `${p.a} and ${p.b} are duplicates`, `They ${p.basis}. Keep one and fold the other into it to save orders and simplify.`);
  for (const p of overlaps.pairs.filter(p => !p.duplicate && p.overlap >= RULES.fundOverlap)) add('medium', 'overlap-' + p.a + p.b, `${p.a} and ${p.b} overlap by about ${pct(p.overlap)}`, `Measured on disclosed top holdings (${p.basis}).`);

  const small = open.filter(p => p.value / tot < RULES.smallPosition);
  if (small.length >= 2) add('low', 'small', `${small.length} positions are under ${pct(RULES.smallPosition)} each`, `${small.map(p => p.symbol).join(', ')}. Small positions barely move results but add orders, tracking and tax paperwork; consolidate or build them up.`);

  if (isFinite(look.fundExpenseRatio)) {
    const pricey = open.filter(p => (look.fundsDb?.funds?.[p.symbol]?.expenseRatio || 0) >= RULES.expensiveFund);
    add(pricey.length ? 'low' : 'good', 'fees', `Average fund fee ${look.fundExpenseRatio.toFixed(2)}% a year`,
      pricey.length ? `${pricey.map(p => `${p.symbol} (${look.fundsDb.funds[p.symbol].expenseRatio}%)`).join(', ')} cost more than ${RULES.expensiveFund}%; check the extra fee buys something you want.` : 'Your funds are low-cost.');
  }
  const buys = ledger.positions.flatMap(p => p.trades.filter(t => t.side === 'BUY'));
  const avgBuy = buys.reduce((a, t) => a + t.amount, 0) / Math.max(1, buys.length);
  const commPct = -kpis.commissions / Math.max(1, ledger.positions.reduce((a, p) => a + p.bought + p.sold, 0));
  if (avgBuy < RULES.smallTrade) add('medium', 'trade-size', `Average buy is only $${Math.round(avgBuy)}`, `With a $1 minimum commission that is ${(100 / avgBuy).toFixed(2)}% per order. Batching deposits into fewer, larger orders cuts costs.`);
  else add('good', 'trade-size', `Trading costs are ${(commPct * 100).toFixed(2)}% of traded value`, 'Order sizes are large enough that commissions are a minor drag.');

  const quick = ledger.positions.filter(p => !p.open && p.holdingDays < 90).length;
  if (quick >= 3) add('low', 'churn', `${quick} positions were bought and fully sold within 90 days`, 'Short holding periods raise costs and, in most countries, taxes on gains. Consider a written reason before each sale.');

  const cashW = Math.max(0, kpis.cash) / tot;
  if (cashW > RULES.cashDrag) add('low', 'cash', `${pct(cashW)} sits in uninvested cash`, 'Idle cash earns little; invest it or move it to a T-bill fund if it is a deliberate reserve.');

  for (const p of open.filter(p => p.costBasis && p.unrealized / p.costBasis <= RULES.loser)) {
    add('low', 'loser-' + p.symbol, `${p.symbol} is ${pct(p.unrealized / p.costBasis)} below cost`, `Unrealized ${Math.round(p.unrealized)} USD. Re-check the original reason for owning it rather than anchoring on the purchase price.`);
  }
  if (bench && isFinite(bench.diff)) {
    add(bench.diff >= 0 ? 'good' : 'medium', 'vs-index', bench.diff >= 0 ? `Ahead of the S&P 500 by $${Math.round(bench.diff)}` : `Behind the S&P 500 by $${Math.round(-bench.diff)}`,
      `Same deposits on the same days into SPY would be worth $${Math.round(bench.value)} (price only). ${bench.diff < 0 ? 'Consistent underperformance is the strongest argument for a simpler index core.' : ''}`);
  }
  if (look.unknown.length) add('low', 'unclassified', `${look.unknown.length} holding${look.unknown.length > 1 ? 's are' : ' is'} not classified yet`, `${look.unknown.join(', ')}: add them to data/tickers.json; the workflow fills data/funds.json.`);
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
export function rebalancePlan({ positions, cash, targets, prices, newMoney = 0, cashTarget = 0, minTrade = 50, fractional = false, commission = t => Math.min(Math.max(1, 0.005 * t.qty), 0.01 * t.value), asOf }) {
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
    t.commission = commission(t);
    t.gain = isFinite(r.avgCost) ? t.qty * (r.price - r.avgCost) : NaN;
    t.shortTerm = r.heldDays != null && r.heldDays < 365;
    cashAfter += t.value - t.commission;
    trades.push(t);
  }
  const buys = rows.filter(r => r.qty > 0 && r.value >= minTrade).sort((a, b) => b.value - a.value);
  const need = buys.reduce((a, r) => a + r.value, 0) + buys.length;
  const spendable = cashAfter - total * cashTarget;
  const scale = need > spendable && need > 0 ? Math.max(0, spendable) / need : 1;
  for (const r of buys) {
    let qty = r.qty * scale;
    if (!fractional) qty = Math.floor(qty);
    if (qty <= 0) continue;
    const t = { side: 'BUY', symbol: r.symbol, qty, price: r.price, value: qty * r.price };
    t.commission = commission(t);
    cashAfter -= t.value + t.commission;
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
      }).filter(c => c.gap > c.r.price * 0.5 && (!c.tr || c.tr.side === 'BUY') && cashAfter - floor >= c.r.price + (c.tr ? 0 : 1));
      if (!cands.length) break;
      const c = cands.sort((a, b) => b.gap / b.r.target - a.gap / a.r.target)[0];
      if (c.tr) { cashAfter += c.tr.commission; c.tr.qty += 1; c.tr.value += c.r.price; c.tr.commission = commission(c.tr); cashAfter -= c.r.price + c.tr.commission; }
      else { const t = { side: 'BUY', symbol: c.r.symbol, qty: 1, price: c.r.price, value: c.r.price }; t.commission = commission(t); cashAfter -= t.value + t.commission; trades.push(t); }
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
      commissions: trades.reduce((a, t) => a + t.commission, 0),
      gains: trades.filter(t => t.side === 'SELL' && isFinite(t.gain)).reduce((a, t) => a + t.gain, 0),
      shortTermGains: trades.filter(t => t.side === 'SELL' && t.shortTerm && t.gain > 0).reduce((a, t) => a + t.gain, 0),
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
    },
    holdings: open.map(p => ({ symbol: p.symbol, name: p.name, type: p.type, weight: r(p.value / look.total), value: r(p.value, 0), unrealizedPct: r(p.costBasis ? p.unrealized / p.costBasis : null), totalReturnUsd: r(p.total, 0), heldDays: p.holdingDays })),
    closedPositions: ledger.positions.filter(p => !p.open).map(p => ({ symbol: p.symbol, totalReturnUsd: r(p.total, 0), returnPct: r(p.returnOnCapital), heldDays: p.holdingDays })),
    lookThrough: {
      sectors: look.sectors.map(s => ({ sector: s.label, weight: r(s.weight), sp500: r(look.marketSectors[s.key] || 0) })),
      regionsOfEquity: look.regions.map(x => ({ region: x.label, share: r(x.ofEquity) })),
      assetClasses: look.assets.map(a => ({ assetClass: a.label, weight: r(a.weight) })),
      topCompanies: look.companies.slice(0, 15).map(c => ({ symbol: c.symbol, total: r(c.total), direct: r(c.direct), viaFunds: Object.fromEntries(Object.entries(c.via).map(([k, v]) => [k, r(v)])) })),
      averageFundExpenseRatioPct: r(look.fundExpenseRatio, 3),
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

export const AI_SYSTEM = `You review personal investment portfolios for a private investor. You receive a JSON summary of an Interactive Brokers cash account: holdings with weights, look-through sector/region/company exposure, fund overlaps, performance, costs, and the findings of a simple rule engine.

Give a candid, specific review: name tickers and numbers from the data, explain why each issue matters, and propose concrete, proportionate actions (e.g. "fold SPY into VOO", "direct the next two deposits to VXUS"). Prefer low-cost, diversified, tax-aware moves; favour using new deposits over selling when that achieves the same goal. Do not invent data that is not in the summary; say when something depends on the investor's goals, horizon or tax residence. This is educational analysis, not personalised financial advice; do not add boilerplate disclaimers beyond one short clause in the summary.`;
