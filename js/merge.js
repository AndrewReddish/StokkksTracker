// Merges several parsed statements into one chronological model.
// Overlapping statements are safe: identical rows are counted per file and the
// merged set keeps the maximum count seen in any single file.

const KEYS = {
  trades: t => [t.symbol, t.dt, t.qty, t.price, t.proceeds].join('|'),
  deposits: d => [d.ccy, d.date, d.amount, d.desc].join('|'),
  dividends: d => [d.ccy, d.date, d.amount, d.desc].join('|'),
  withholding: d => [d.ccy, d.date, d.amount, d.desc].join('|'),
  interest: d => [d.ccy, d.date, d.amount, d.desc].join('|'),
  fees: d => [d.ccy, d.date, d.amount, d.desc].join('|'),
  corporateActions: d => [d.date, d.desc, d.qty].join('|'),
};

function mergeList(statements, field) {
  const keyOf = KEYS[field];
  const best = new Map(); // key -> {count, items}
  for (const s of statements) {
    const local = new Map();
    for (const item of s[field] || []) {
      const k = keyOf(item);
      (local.get(k) || local.set(k, []).get(k)).push(item);
    }
    for (const [k, items] of local) {
      const prev = best.get(k);
      if (!prev || items.length > prev.length) best.set(k, items);
    }
  }
  return [...best.values()].flat();
}

const byDate = (a, b) => (a.dt || a.date).localeCompare(b.dt || b.date);

export function mergeStatements(statements) {
  if (!statements.length) throw new Error('No statements');
  const accounts = new Set(statements.map(s => s.meta.account));
  const sorted = [...statements].sort((a, b) => a.meta.periodStart.localeCompare(b.meta.periodStart));
  const merged = {
    accounts: [...accounts],
    name: sorted[0].meta.name,
    baseCcy: sorted[0].meta.baseCcy,
    periodStart: sorted[0].meta.periodStart,
    periodEnd: sorted.map(s => s.meta.periodEnd).sort().at(-1),
    statements: sorted.map(s => ({ ...s.meta, nav: s.nav, cash: s.cash, accruals: s.accruals, openPositions: s.openPositions, depositTotals: s.depositTotals })),
    instruments: Object.assign({}, ...sorted.map(s => s.instruments)),
    mtm: sorted.flatMap(s => s.mtm.map(m => ({ ...m, periodStart: s.meta.periodStart, periodEnd: s.meta.periodEnd }))),
  };
  for (const f of Object.keys(KEYS)) merged[f] = mergeList(sorted, f).sort(byDate);

  // Latest statement's open positions are the "current" snapshot.
  const latest = sorted.reduce((a, b) => (a.meta.periodEnd >= b.meta.periodEnd ? a : b));
  merged.openPositions = latest.openPositions;
  merged.latest = latest.meta;
  merged.warnings = [];
  if (accounts.size > 1) merged.warnings.push(`Statements belong to ${accounts.size} different accounts (${[...accounts].join(', ')}); they are combined.`);
  // Gap detection between statement periods.
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].meta.periodEnd);
    const start = new Date(sorted[i].meta.periodStart);
    if ((start - prevEnd) / 864e5 > 4) merged.warnings.push(`Gap between ${sorted[i - 1].meta.periodEnd} and ${sorted[i].meta.periodStart}: activity in that window is missing.`);
  }
  return merged;
}
