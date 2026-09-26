// Command-line summary of one or more IBKR Activity Statement CSVs.
// Usage: node tools/analyze.mjs path/to/statement1.csv [statement2.csv ...]
// Uses data/prices/*.json when present, otherwise statement prices.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFiles, analyze, neededSymbols } from '../js/engine.js';
import { cacheFileName } from '../js/prices.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = process.argv.slice(2);
if (!paths.length) { console.error('Usage: node tools/analyze.mjs <statement.csv> [...]'); process.exit(1); }
const model = parseFiles(paths.map(p => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') })));
const need = neededSymbols(model);
const cache = {};
for (const s of [...need.symbols, ...need.benchmarks, ...need.fx]) {
  const f = path.join(root, 'data/prices', cacheFileName(s));
  if (fs.existsSync(f)) cache[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
}
const { kpis: k, ledger } = analyze(model, cache);
const $ = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pc = v => (v * 100).toFixed(2) + '%';
console.log(`Period ${ledger.startDate} → ${ledger.endDate} · prices cached for ${Object.keys(cache).length} symbols`);
console.log(`NAV ${$(k.nav)} · net deposits ${$(k.netDeposits)} · gain ${$(k.gain)} (${pc(k.gainPct)})`);
console.log(`TWR ${pc(k.twr)} (IBKR ${pc(k.ibkrTwrChain)}) · IRR ${pc(k.xirr)} · max drawdown ${pc(k.maxDD)} (${k.ddPeak} → ${k.ddTrough})`);
console.log(`Realized ${$(k.realized)} · unrealized ${$(k.unrealized)} · dividends ${$(k.dividends)} · tax ${$(k.tax)} · commissions ${$(k.commissions)}`);
for (const r of k.recon) console.log(`Reconcile ${r.period}: IBKR ${$(r.statementNav)} vs rebuilt ${$(r.computed + r.accruals)} (diff ${$(r.diff)})`);
console.log('\nSymbol  Open      Value   Realized  Unrealzd  Divs(net)     Total   Return  Src');
for (const p of ledger.positions) {
  console.log([p.symbol.padEnd(6), (p.open ? 'yes' : 'no').padEnd(4), $(p.value).padStart(10), $(p.realized).padStart(10), $(p.unrealized).padStart(9), $(p.income).padStart(10), $(p.total).padStart(9), pc(p.returnOnCapital).padStart(8), p.priceSource].join('  '));
}
