// One-call pipeline shared by the browser app and the Node analysis script.
import { parseStatement } from './parser.js';
import { mergeStatements } from './merge.js';
import { buildPriceBook, fxCacheName } from './prices.js';
import { runLedger } from './ledger.js';
import { computeKPIs } from './metrics.js';

export const BENCHMARKS = ['SPY', 'QQQ'];

export function parseFiles(files) {
  return mergeStatements(files.map(f => parseStatement(f.text, f.name)));
}

export function neededSymbols(model) {
  const syms = new Set(model.trades.filter(t => t.kind !== 'forex').map(t => t.symbol));
  model.mtm.forEach(m => syms.add(m.symbol));
  const fx = new Set(model.deposits.map(d => d.ccy).filter(c => c !== model.baseCcy));
  return { symbols: [...syms].sort(), fx: [...fx].map(fxCacheName), benchmarks: BENCHMARKS };
}

export function analyze(model, cache = {}) {
  const book = buildPriceBook(model, cache);
  const ledger = runLedger(model, book);
  const kpis = computeKPIs(model, ledger);
  return { model, book, ledger, kpis };
}
