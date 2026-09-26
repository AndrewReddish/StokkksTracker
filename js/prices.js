// Daily price lookup. Primary source: the JSON cache in data/prices/ that the
// GitHub Action keeps fresh. Fallback: anchor prices taken from the statements
// themselves (each trade's closing price, period-boundary marks, open-position
// closes), linearly interpolated between anchors.

export const cacheFileName = sym => sym.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
export const fxCacheName = ccy => `FX_${ccy}`;

export async function loadPriceCache(symbols, base = 'data/prices/') {
  const out = {};
  // index.json lists the cached symbols, so missing ones are not requested.
  let available = null;
  try {
    const res = await fetch(base + 'index.json', { cache: 'no-cache' });
    if (res.ok) available = new Set((await res.json()).symbols);
  } catch { /* offline or file:// */ }
  if (!available) return out;
  await Promise.all(symbols.filter(s => available.has(cacheFileName(s).replace(/\.json$/, ''))).map(async sym => {
    try {
      const res = await fetch(base + cacheFileName(sym), { cache: 'no-cache' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.dates) && Array.isArray(j.close) && j.dates.length) out[sym] = j;
    } catch { /* offline or file:// — fall back to statement anchors */ }
  }));
  return out;
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

const dayNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;

function anchorSeries(points) {
  // points: [{date, price}] -> sorted unique by date (last one wins)
  const m = new Map();
  for (const p of points) if (p.date && isFinite(p.price) && p.price > 0) m.set(p.date, p.price);
  const dates = [...m.keys()].sort();
  return { dates, prices: dates.map(d => m.get(d)) };
}

function interpolator({ dates, prices }) {
  if (!dates.length) return () => NaN;
  const xs = dates.map(dayNum);
  return date => {
    const x = dayNum(date);
    const i = bisectRight(xs, x);
    if (i === 0) return prices[0];
    if (i >= xs.length) return prices[xs.length - 1];
    const x0 = xs[i - 1], x1 = xs[i];
    if (x === x0) return prices[i - 1];
    return prices[i - 1] + (prices[i] - prices[i - 1]) * (x - x0) / (x1 - x0);
  };
}

function stepper({ dates, close }) {
  return date => {
    const i = bisectRight(dates, date);
    return i === 0 ? NaN : close[i - 1];
  };
}

const prevDay = d => new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);

export function buildPriceBook(model, cache = {}) {
  const anchors = {};
  const add = (sym, date, price) => (anchors[sym] ||= []).push({ date, price });
  for (const t of model.trades) {
    if (t.kind === 'forex') {
      const [base, quote] = t.symbol.split('.');
      if (quote === model.baseCcy) add(fxCacheName(base), t.date, t.price);
      continue;
    }
    add(t.symbol, t.date, isFinite(t.closePrice) ? t.closePrice : t.price);
  }
  for (const m of model.mtm) {
    if (isFinite(m.priorPrice) && m.priorQty) add(m.symbol, prevDay(m.periodStart), m.priorPrice);
    if (isFinite(m.price) && m.qty) add(m.symbol, m.periodEnd, m.price);
  }
  for (const s of model.statements) for (const p of s.openPositions) add(p.symbol, s.periodEnd, p.closePrice);
  // Implied FX rate for each non-base deposit currency from statement totals.
  for (const s of model.statements) for (const [ccy, t] of Object.entries(s.depositTotals || {})) {
    if (ccy !== model.baseCcy && t.native && t.base) add(fxCacheName(ccy) + '_implied', s.periodEnd, t.base / t.native);
  }

  const book = {};
  const symbols = new Set([...Object.keys(anchors), ...Object.keys(cache)]);
  for (const sym of symbols) {
    const a = anchorSeries(anchors[sym] || []);
    const interp = interpolator(a);
    const c = cache[sym];
    if (c) {
      const step = stepper(c);
      const first = c.dates[0], last = c.dates.at(-1);
      book[sym] = {
        source: 'market',
        cached: { first, last, updated: c.updated },
        at: date => {
          if (date < first || !isFinite(step(date))) return interp(date);
          return step(date);
        },
        series: c,
        anchors: a,
      };
    } else {
      book[sym] = { source: 'statement', at: interp, anchors: a };
    }
  }
  book.fx = ccy => {
    if (ccy === model.baseCcy) return () => 1;
    const b = book[fxCacheName(ccy)] || book[fxCacheName(ccy) + '_implied'];
    return b ? b.at : () => 1;
  };
  return book;
}
