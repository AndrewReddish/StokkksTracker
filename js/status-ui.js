// Data status tab: what loaded, from where, as of when, and every place the report is
// missing data. Nothing here is inferred; each line points at the file or source involved.

const DAY = 864e5;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

export function collectWarnings({ state, fundsDb }) {
  const out = [];
  const add = (level, area, text) => out.push({ level, area, text });
  const { model, ledger, book, kpis } = state;
  const end = ledger.endDate;
  const status = state.priceStatus || {};
  const held = new Set(ledger.positions.filter(p => p.open).map(p => p.symbol));

  for (const w of model.warnings) add('warn', 'Statements', w);
  for (const w of ledger.warnings) add(w.level, w.area, w.text);

  for (const sym of state.need.symbols) {
    const st = status[sym];
    const b = book[sym];
    if (st?.state !== 'loaded') {
      const pts = b?.points?.dates.length || 0;
      add(held.has(sym) ? 'error' : 'warn', 'Prices', `${sym}: no daily prices (${st?.detail || 'not loaded'}). Its chart shows only the ${pts} price${pts === 1 ? '' : 's'} printed in your statements, and between them the last one is carried forward. Add ${sym} to data/tickers.json to fetch daily closes.`);
    } else if (held.has(sym) && b?.cached && daysBetween(b.cached.last, end) > 4) {
      add('warn', 'Prices', `${sym}: latest daily close is ${b.cached.last}, ${daysBetween(b.cached.last, end)} days before the statement end (${end}).`);
    }
  }
  for (const sym of state.need.benchmarks) {
    if (status[sym]?.state !== 'loaded') add('warn', 'Benchmarks', `${sym}: no daily prices (${status[sym]?.detail || 'not loaded'}), so comparisons with it are hidden.`);
  }
  for (const fx of state.need.fx) {
    if (status[fx]?.state !== 'loaded') add('warn', 'FX', `${fx.replace('FX_', '')}/${model.baseCcy}: no daily rates (${status[fx]?.detail || 'not loaded'}); conversions use the rates of your own currency trades.`);
  }
  for (const n of ledger.fxNotes) {
    if (n.scale != null && Math.abs(n.scale - 1) > 0.0005) {
      add('info', 'FX', `${n.ccy} deposits ${n.period}: valued at each day's ${n.ccy}/${model.baseCcy} close, then multiplied by ${n.scale.toFixed(4)} so they add up to IBKR's "Total in ${model.baseCcy}" (${n.base.toFixed(2)}).`);
    }
  }
  for (const r of kpis.recon) {
    if (Math.abs(r.diff) > 1) add('warn', 'Reconciliation', `${r.period}: rebuilt value differs from IBKR's by ${r.diff.toFixed(2)} ${model.baseCcy}.`);
    if (r.accruals) add('info', 'Reconciliation', `${r.period}: IBKR's ending value includes ${r.accruals.toFixed(2)} ${model.baseCcy} of dividends declared but not yet paid; the report counts dividends when they are paid.`);
  }

  if (fundsDb.loadError) add('error', 'Fund data', `data/funds.json did not load: ${fundsDb.loadError}. Look-through, overlap and sector checks are empty.`);
  const funds = fundsDb.funds || {};
  for (const sym of held) {
    const f = funds[sym];
    const st = fundsDb.status?.[sym];
    if (!f) { add('warn', 'Fund data', `${sym}: no classification or holdings data${st?.errors?.length ? ` (last attempt: ${st.errors.join('; ')})` : ' (not fetched yet)'}. It counts as "Not classified".`); continue; }
    if (f.kind === 'stock') {
      if (!f.sector) add('warn', 'Fund data', `${sym}: no sector in its profile.`);
      if (!f.region) add('warn', 'Fund data', `${sym}: no country found (SEC filing address), so its region is "Not classified".`);
      continue;
    }
    const gaps = [];
    if (!f.assetClass) gaps.push('asset class not loaded');
    if ((f.sectorCoverage || 0) < 0.97) gaps.push(`sector known for ${((f.sectorCoverage || 0) * 100).toFixed(0)}% of the fund`);
    if ((f.regionCoverage || 0) < 0.97) gaps.push(`country known for ${((f.regionCoverage || 0) * 100).toFixed(0)}%`);
    if ((f.storedWeight ?? 0) < 0.97) gaps.push(`holdings: top ${f.holdings.length} only (${(f.storedWeight * 100).toFixed(0)}% of the fund)`);
    if (gaps.length) {
      const serious = !f.assetClass || (f.sectorCoverage || 0) < 0.5 || (f.regionCoverage || 0) < 0.5;
      add(serious ? 'warn' : 'info', 'Fund data', `${sym} (${f.source}): ${gaps.join('; ')}. The missing part counts as "Not classified".`);
    }
  }
  if (!funds.SPY?.sectors || (funds.SPY.sectorCoverage || 0) < 0.9) add('info', 'Benchmarks', 'S&P 500 sector weights are not loaded (they come from SPY\'s holdings file), so sector comparisons with the index are hidden.');
  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export function renderStatus(ctx) {
  const { $, esc, state, fundsDb } = ctx;
  const warnings = collectWarnings(ctx);
  const n = l => warnings.filter(w => w.level === l).length;
  const badge = n('error') + n('warn');
  $('#tabbtn-status').innerHTML = `Data status${badge ? ` <span class="tab-badge${n('error') ? ' err' : ''}">${badge}</span>` : ''}`;

  const status = state.priceStatus || {};
  const syms = [...state.need.symbols];
  const loaded = syms.filter(s => status[s]?.state === 'loaded').length;
  const funds = fundsDb.funds || {};
  const held = new Set(state.ledger.positions.filter(p => p.open).map(p => p.symbol));
  const heldWithFund = [...held].filter(s => funds[s]).length;
  $('#st-summary').innerHTML = [
    ['Daily prices', `${loaded} / ${syms.length}`, 'tickers in your statements with a price file'],
    ['Classification', `${heldWithFund} / ${held.size}`, 'current holdings with fund or company data'],
    ['Errors', n('error'), 'missing data that changes numbers'],
    ['Warnings', n('warn'), 'missing data that limits a check'],
  ].map(([t, v, d]) => `<div class="kpi"><dt>${t}</dt><dd>${v}</dd><div class="note">${d}</div></div>`).join('');

  const icon = { error: '!', warn: '•', info: 'i' };
  const label = { error: 'Error', warn: 'Warning', info: 'Info' };
  $('#st-warnings').innerHTML = warnings.length ? warnings.map(w => `<article class="finding f-${w.level}"><span class="f-icon" aria-hidden="true">${icon[w.level]}</span>
      <div><div class="f-title"><span class="sev-pill sev-${w.level}">${label[w.level]}</span> ${esc(w.area)}</div><p>${esc(w.text)}</p></div></article>`).join('')
    : '<p class="sub">Everything loaded. No warnings.</p>';

  const all = [...new Set([...syms, ...state.need.benchmarks, ...state.need.fx])];
  const fundStatus = fundsDb.status || {};
  const pill = (ok, text) => `<span class="pill ${ok === true ? 'ok' : ok === false ? 'bad' : 'src'}">${esc(text)}</span>`;
  $('#tbl-status').innerHTML = `<thead><tr><th class="l">Ticker</th><th class="l">Held</th><th class="l">Daily prices</th><th class="l">Range</th><th>Statement prices</th><th class="l">Classification / holdings</th><th class="l">Fetched</th></tr></thead><tbody>${all.map(sym => {
    const st = status[sym] || { state: 'not-requested' };
    const b = state.book[sym];
    const f = funds[sym], fs = fundStatus[sym];
    const priceCell = st.state === 'loaded' ? pill(true, 'Loaded') : pill(false, { 'not-in-cache': 'No file', 'fetch-failed': 'Failed', 'no-cache': 'Unavailable', 'not-requested': 'Not requested' }[st.state] || st.state);
    const range = b?.cached ? `${b.cached.first} → ${b.cached.last} (${b.cached.days} days)` : (st.detail ? esc(st.detail) : '—');
    let cls = '—';
    if (sym.startsWith('FX_')) cls = 'Exchange rate';
    else if (f?.kind === 'stock') cls = `Stock · ${esc(f.sectorName || 'no sector')} · ${esc(f.country || 'no country')} <small class="muted">(${esc(f.source)})</small>`;
    else if (f?.kind === 'etf') cls = `Fund · ${f.holdingsCount} holdings${(f.storedWeight ?? 0) < 0.97 ? ` (top ${f.holdings.length}, ${(f.storedWeight * 100).toFixed(0)}% of fund)` : ''} · sectors ${((f.sectorCoverage || 0) * 100).toFixed(0)}% · countries ${((f.regionCoverage || 0) * 100).toFixed(0)}%${f.assetClassName ? ` · ${esc(f.assetClassName)}` : ''}${isFinite(f.expenseRatio) ? ` · fee ${f.expenseRatio}%` : ''} <small class="muted">(${esc(f.source)})</small>`;
    else if (fs && !fs.ok) cls = `${pill(false, 'Failed')} <small class="muted">${esc((fs.errors || []).join('; ').slice(0, 220))}</small>`;
    else if (!state.need.benchmarks.includes(sym)) cls = pill(false, 'Not fetched');
    const fetched = f?.asOf || (fs?.checkedAt || '').slice(0, 10) || '—';
    return `<tr><td class="l sym">${esc(sym)}</td><td class="l">${held.has(sym) ? 'Yes' : ''}</td><td class="l">${priceCell}</td><td class="l">${range}</td><td>${b?.points?.dates.length ?? 0}</td><td class="l wrap">${cls}</td><td class="l">${esc(fetched)}</td></tr>`;
  }).join('')}</tbody>`;
  $('#st-sources').innerHTML = `Price files updated ${esc(Object.values(state.cache).map(c => c.updated).filter(Boolean).sort().at(-1)?.slice(0, 10) || 'never')} · fund data updated ${esc((fundsDb.updated || 'never').slice(0, 10))}.`;
  return warnings;
}
