// One-call pipeline shared by the browser app and the Node analysis script.
import { parseStatement } from './parser.js';
import { mergeStatements } from './merge.js';
import { buildPriceBook, fxCacheName } from './prices.js';
import { runLedger } from './ledger.js';
import { computeKPIs } from './metrics.js';
import { outsideCosts } from './outside-costs.js';

export const BENCHMARKS = ['SPY', 'QQQ'];

export function parseFiles(files) {
  return mergeStatements(files.map(f => parseStatement(f.text, f.name)));
}

export function neededSymbols(model) {
  const syms = new Set(model.trades.filter(t => t.kind !== 'forex').map(t => t.symbol));
  model.mtm.filter(m => m.category !== 'Forex').forEach(m => syms.add(m.symbol));
  const fx = new Set(model.deposits.map(d => d.ccy).filter(c => c !== model.baseCcy));
  return { symbols: [...syms].sort(), fx: [...fx].map(fxCacheName), benchmarks: BENCHMARKS };
}

// costSettings: deposit commission and tax paid outside IBKR (see outside-costs.js).
export function analyze(model, cache = {}, costSettings) {
  const book = buildPriceBook(model, cache);
  const ledger = runLedger(model, book);
  const costs = outsideCosts(model, ledger, book, costSettings);
  const kpis = computeKPIs(model, ledger, costs.events);
  return { model, book, ledger, kpis, costs };
}

// Re-applies changed outside-cost settings without replaying the ledger.
export function recost({ model, book, ledger }, costSettings) {
  const costs = outsideCosts(model, ledger, book, costSettings);
  return { costs, kpis: computeKPIs(model, ledger, costs.events) };
}
