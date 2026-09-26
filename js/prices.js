// Daily price lookup. Only observed prices are used, never interpolated:
// 1. the daily closes in data/prices/ (kept fresh by the GitHub workflow);
// 2. otherwise prices printed in the statements themselves: each trade's closing
//    price for that day, period-boundary marks and open-position closes.
// On a day without an observation the last observed close is carried forward,
// and the date of that observation is available for the Data status page.

export const cacheFileName = sym => sym.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
export const fxCacheName = ccy => `FX_${ccy}`;

// Returns { prices: {sym: series}, status: {sym: {state, detail}} }.
export async function loadPriceCache(symbols, base = 'data/prices/') {
  const prices = {}, status = {};
  let available = null, indexError = null;
  try {
    const res = await fetch(base + 'index.json', { cache: 'no-cache' });
    if (res.ok) available = new Set((await res.json()).symbols);
    else indexError = `index.json returned HTTP ${res.status}`;
  } catch (e) { indexError = location.protocol === 'file:' ? 'the page was opened from disk (file://), so the browser blocks loading data files' : `could not load index.json (${e.message})`; }
  for (const sym of symbols) {
    if (!available) { status[sym] = { state: 'no-cache', detail: indexError }; continue; }
    if (!available.has(cacheFileName(sym).replace(/\.json$/, ''))) status[sym] = { state: 'not-in-cache', detail: 'no price file in data/prices/' };
  }
  if (!available) return { prices, status };
  await Promise.all(symbols.filter(s => !status[s]).map(async sym => {
    try {
      const res = await fetch(base + cacheFileName(sym), { cache: 'no-cache' });
      if (!res.ok) { status[sym] = { state: 'fetch-failed', detail: `HTTP ${res.status}` }; return; }
      const j = await res.json();
      if (Array.isArray(j.dates) && Array.isArray(j.close) && j.dates.length) { prices[sym] = j; status[sym] = { state: 'loaded' }; }
      else status[sym] = { state: 'fetch-failed', detail: 'file has no prices' };
    } catch (e) { status[sym] = { state: 'fetch-failed', detail: e.message }; }
  }));
  return { prices, status };
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

function pointSeries(points) {
  // [{date, price}] -> sorted, one observation per date (the last one listed wins)
  const m = new Map();
  for (const p of points) if (p.date && isFinite(p.price) && p.price > 0) m.set(p.date, p.price);
  const dates = [...m.keys()].sort();
  return { dates, prices: dates.map(d => m.get(d)) };
}

// Last observation on or before `date`: {price, date} or null.
function lastObs(dates, values, date) {
  const i = bisectRight(dates, date);
  return i === 0 ? null : { price: values[i - 1], date: dates[i - 1] };
}

const prevDay = d => new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);

export function buildPriceBook(model, cache = {}) {
  const points = {};
  const add = (sym, date, price) => (points[sym] ||= []).push({ date, price });
  for (const t of model.trades) {
    if (t.kind === 'forex') {
      // Executed conversion rate on that day.
      const [base, quote] = t.symbol.split('.');
      if (quote === model.baseCcy) add(fxCacheName(base), t.date, t.price);
      continue;
    }
    add(t.symbol, t.date, isFinite(t.closePrice) ? t.closePrice : t.price);
  }
  for (const m of model.mtm.filter(m => m.category !== 'Forex')) {
    if (isFinite(m.priorPrice) && m.priorQty) add(m.symbol, prevDay(m.periodStart), m.priorPrice);
    if (isFinite(m.price) && m.qty) add(m.symbol, m.periodEnd, m.price);
  }
  for (const s of model.statements) for (const p of s.openPositions) add(p.symbol, s.periodEnd, p.closePrice);

  const book = {};
  const symbols = new Set([...Object.keys(points), ...Object.keys(cache)]);
  for (const sym of symbols) {
    const pts = pointSeries(points[sym] || []);
    const c = cache[sym];
    const obs = date => {
      if (c && date >= c.dates[0]) { const o = lastObs(c.dates, c.close, date); if (o) return { ...o, source: 'market' }; }
      const o = lastObs(pts.dates, pts.prices, date);
      return o ? { ...o, source: 'statement' } : null;
    };
    book[sym] = {
      source: c ? 'market' : 'statement',
      cached: c ? { first: c.dates[0], last: c.dates.at(-1), updated: c.updated, days: c.dates.length } : null,
      points: pts,
      obs,
      at: date => obs(date)?.price ?? NaN,
    };
  }
  book.fx = ccy => {
    if (ccy === model.baseCcy) return () => 1;
    const b = book[fxCacheName(ccy)];
    return b ? b.at : () => NaN;
  };
  return book;
}
