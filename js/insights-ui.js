// Insights tab: checkup findings, look-through exposure, fund overlap, rebalancing and the
// optional Claude review. Receives a context object from app.js with state and helpers.
import { moneyHidden, maskText } from './privacy.js';
import { lookThrough, fundOverlaps, healthChecks, presetTargets, rebalancePlan, aiPayload, AI_SCHEMA, AI_SYSTEM, RULES } from './insights.js';

const TARGETS_KEY = 'stokkks.rebalance.v1';
const GOALS_KEY = 'stokkks.goals.v1';
const MODEL = 'claude-opus-5';
let apiKey = ''; // held in memory only; never written to storage
let ui = null;   // { look, overlaps, checks, plan, settings }
let lastReview = null; // re-rendered when Hide $ is toggled

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export function renderInsights(ctx) {
  const { state, fundsDb } = ctx;
  const look = lookThrough(state.ledger.positions, state.kpis.cash, fundsDb);
  const overlaps = fundOverlaps(state.ledger.positions, fundsDb);
  const b = state.extras.bench.SPY;
  const bench = b ? { value: b.same.at(-1), diff: state.kpis.nav - b.same.at(-1) } : null;
  const checks = healthChecks({ kpis: state.kpis, ledger: state.ledger, look, overlaps, bench });
  const acct = state.model.accounts.join(',') + (ctx.demo ? ':demo' : '');
  const stored = load(TARGETS_KEY, {})[acct];
  const settings = stored || { preset: 'current', newMoney: 0, cashTarget: 0, minTrade: 25, fractional: true, targets: null };
  if (!settings.targets) settings.targets = presetTargets(settings.preset, state.ledger.positions, look.total);
  ui = { look, overlaps, checks, settings, acct, ctx };
  renderHeadline(ctx);
  renderFindings(ctx);
  renderMix(ctx);
  renderCompanies(ctx);
  renderOverlap(ctx);
  renderRebalance(ctx);
  renderAiPanel(ctx);
  if (lastReview) renderReview(ctx, lastReview.r, lastReview.msg);
}

export function renderInsightsCharts(ctx) {
  if (!ui) return;
  renderSectorChart(ctx);
}

/* ---------- checkup ---------- */
function renderHeadline({ $, esc }) {
  const n = s => ui.checks.filter(c => c.severity === s).length;
  const hi = n('high'), med = n('medium'), low = n('low'), good = n('good');
  const line = hi ? `${hi} issue${hi > 1 ? 's' : ''} need${hi > 1 ? '' : 's'} attention, ${med} worth reviewing.`
    : med ? `No urgent issues. ${med} thing${med > 1 ? 's' : ''} worth reviewing.` : 'No significant issues found.';
  $('#ins-headline').textContent = line;
  $('#ins-counts').innerHTML = [['high', hi, 'Act'], ['medium', med, 'Review'], ['low', low, 'Note'], ['good', good, 'Fine']]
    .map(([s, c, t]) => `<span class="sev sev-${s}"><b>${c}</b> ${esc(t)}</span>`).join('');
}
const SEV_ICON = { high: '!', medium: '•', low: 'i', good: '✓' };
const SEV_LABEL = { high: 'Act', medium: 'Review', low: 'Note', good: 'Fine' };
function renderFindings({ $, esc }) {
  $('#ins-findings').innerHTML = ui.checks.map(c => `<article class="finding f-${c.severity}">
      <span class="f-icon" aria-hidden="true">${SEV_ICON[c.severity]}</span>
      <div><div class="f-title"><span class="sev-pill sev-${c.severity}">${SEV_LABEL[c.severity]}</span> ${esc(c.title)}</div><p>${esc(c.detail)}</p></div>
    </article>`).join('');
}

/* ---------- exposure ---------- */
function bars(rows, esc, colorVar = '--s1') {
  const max = Math.max(...rows.map(r => r.w), 0.0001);
  return rows.map(r => `<div class="hbar"><span class="hbar-l">${esc(r.label)}</span><span class="hbar-t"><i style="width:${(r.w / max) * 100}%;background:var(${r.color || colorVar})"></i></span><span class="hbar-v">${(r.w * 100).toFixed(1)}%</span></div>`).join('');
}
function renderMix({ $, esc }) {
  const { look } = ui;
  const assetColor = { equity: '--s1', bond: '--s3', cash: '--s6', real_estate: '--s7', other: '--s5', unknown: '--other' };
  $('#ins-assets').innerHTML = bars(look.assets.map(a => ({ label: a.label, w: a.weight, color: assetColor[a.key] })), esc);
  $('#ins-regions').innerHTML = look.regions.length ? bars(look.regions.map(r => ({ label: r.label, w: r.ofEquity, color: r.key === 'unknown' ? '--other' : '--s1' })), esc)
    : '<p class="sub">No stock holdings.</p>';
  const er = look.fundExpenseRatio;
  const parts = [];
  if (isFinite(er)) parts.push(`Weighted fund fee ${er.toFixed(2)}% a year${ui.look.erCoverage < 0.999 ? ` (fees loaded for ${(ui.look.erCoverage * 100).toFixed(0)}% of your funds by value)` : ''}.`);
  parts.push('"Not classified" is the part with no loaded data; it is shown, not guessed.');
  $('#ins-mix-note').textContent = parts.join(' ');
}
function renderSectorChart({ state, chart, base, tokens, legend }) {
  const T = tokens();
  const rows = ui.look.sectors.slice().reverse();
  const m = ui.look.marketSectors?.weights;
  legend('#legend-sectors', m ? [[T.s1, 'Your stock holdings (looked through funds)'], [T.other, `S&P 500 (${ui.look.marketSectors.source})`]] : [[T.s1, 'Your stock holdings (looked through funds)']]);
  chart('ch-sectors').setOption(base(T, {
    grid: { left: 20, right: 40, top: 4, bottom: 4, containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: rows.map(r => r.label), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.ink2, fontSize: 12 } },
    tooltip: { ...base(T).tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: v => (v * 100).toFixed(1) + '%' },
    series: [
      { name: 'Your stock holdings', type: 'bar', barWidth: 8, barGap: '30%', data: rows.map(r => ({ value: r.ofEquity, itemStyle: { color: r.key === 'unknown' ? T.other : T.s1, borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', color: T.ink2, fontSize: 11, formatter: p => (p.value * 100).toFixed(0) + '%' } },
      ...(m ? [{ name: 'S&P 500', type: 'bar', barWidth: 8, data: rows.map(r => r.key === 'unknown' ? null : (m[r.key] || 0)), itemStyle: { color: T.axis, borderRadius: [0, 4, 4, 0] } }] : []),
    ],
  }));
}
function renderCompanies({ $, esc }) {
  const rows = ui.look.companies.slice(0, 15);
  $('#tbl-companies').innerHTML = `<thead><tr><th>Company</th><th>Total</th><th>Direct</th><th class="l">Via funds</th></tr></thead><tbody>${rows.map(c =>
    `<tr><td class="sym">${esc(c.symbol)}<small>${esc(c.name)}</small></td><td><b>${(c.total * 100).toFixed(2)}%</b></td><td>${c.direct ? (c.direct * 100).toFixed(2) + '%' : '—'}</td>
     <td class="l">${Object.entries(c.via).sort((a, b) => b[1] - a[1]).map(([f, w]) => `${esc(f)} ${(w * 100).toFixed(2)}%`).join(', ') || '—'}</td></tr>`).join('')}</tbody>`;
}
function renderOverlap({ $, esc }) {
  const { overlaps } = ui;
  const fs = overlaps.funds;
  if (fs.length < 2) { $('#ins-overlap').innerHTML = '<p class="sub">Fewer than two of your funds have loaded holdings, so there is nothing to compare. See Data status.</p>'; return; }
  const get = (a, b) => overlaps.pairs.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const cell = (a, b) => {
    if (a === b) return '<td class="ov-self">—</td>';
    const p = get(a, b);
    const v = p.overlap;
    return `<td class="ov" style="--ov:${Math.min(1, v / 0.6) * 70}%" title="${esc(p.basis)}">${v >= 0.005 ? Math.round(v * 100) + '%' : '0'}</td>`;
  };
  const dups = overlaps.pairs.filter(p => p.duplicate);
  $('#ins-overlap').innerHTML = `<div class="table-wrap"><table class="mini ov-table"><thead><tr><th></th>${fs.map(f => `<th>${esc(f)}</th>`).join('')}</tr></thead>
    <tbody>${fs.map(a => `<tr><th class="l">${esc(a)}</th>${fs.map(b => cell(a, b)).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="sub">Weight two funds have in common, summed over the holdings loaded for both. Where only a fund's top holdings are loaded, the true overlap can be higher.</p>
    ${dups.length ? `<p class="warn-line">Near-identical: ${dups.map(p => `${esc(p.a)} and ${esc(p.b)}`).join(', ')}</p>` : ''}
    ${overlaps.doubled.length ? `<p class="sub">Also held inside your funds: ${overlaps.doubled.map(d => `${esc(d.stock)} in ${esc(d.fund)} (${(d.weightInFund * 100).toFixed(1)}% of the fund)`).join('; ')}.</p>` : ''}`;
}

/* ---------- rebalance ---------- */
function persist() {
  const all = load(TARGETS_KEY, {});
  all[ui.acct] = ui.settings;
  save(TARGETS_KEY, all);
}
function currentPlan(ctx) {
  const { state } = ctx;
  const s = ui.settings;
  const prices = {};
  for (const sym of Object.keys(s.targets)) { const b = state.book[sym]; if (b) prices[sym] = b.at(state.ledger.endDate); }
  Object.assign(prices, s.manualPrices || {});
  return rebalancePlan({ positions: state.ledger.positions, cash: state.kpis.cash, targets: s.targets, prices, newMoney: +s.newMoney || 0, cashTarget: (+s.cashTarget || 0) / 100, minTrade: +s.minTrade || 0, fractional: !!s.fractional, asOf: state.ledger.endDate });
}
function renderRebalance(ctx) {
  const { $ } = ctx;
  const s = ui.settings;
  document.querySelectorAll('#reb-preset button').forEach(b => b.classList.toggle('on', b.dataset.preset === s.preset));
  $('#reb-new').value = s.newMoney || 0;
  $('#reb-cash').value = s.cashTarget || 0;
  $('#reb-min').value = s.minTrade ?? 25;
  $('#reb-frac').checked = !!s.fractional;
  renderPlan(ctx);
}
function renderPlan(ctx) {
  const { $, esc, money, signed, qtyFmt } = ctx;
  const plan = ui.plan = currentPlan(ctx);
  const s = ui.settings;
  const tsum = Object.values(s.targets).reduce((a, x) => a + (x > 0 ? x : 0), 0);
  const tradeOf = sym => plan.trades.find(t => t.symbol === sym);
  $('#tbl-targets').innerHTML = `<thead><tr><th>Holding</th><th>Price</th><th>Value now</th><th>Now</th><th>Target %</th><th>After</th><th>Trade</th></tr></thead>
    <tbody>${plan.rows.map(r => {
      const t = tradeOf(r.symbol);
      const tv = ((s.targets[r.symbol] || 0) / (tsum || 1)) * 100;
      return `<tr><td class="sym">${esc(r.symbol)}<small>${esc(r.name)}</small></td><td>${isFinite(r.price) ? money(r.price, 2) : '<span class="down">no price</span>'}</td>
        <td>${money(r.current)}</td><td>${(r.currentW * 100).toFixed(1)}%</td>
        <td><input class="num" type="number" min="0" max="100" step="0.5" id="tgt-${esc(r.symbol)}" data-sym="${esc(r.symbol)}" value="${tv.toFixed(1)}" aria-label="Target percent for ${esc(r.symbol)}"></td>
        <td>${(r.afterW * 100).toFixed(1)}%</td>
        <td>${t ? `<span class="pill ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? 'Buy' : 'Sell'}</span> ${qtyFmt(t.qty)} · ${money(t.value)}` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>Cash</td><td></td><td>${money(ctx.state.kpis.cash + (+s.newMoney || 0))}</td><td></td><td>${(+s.cashTarget || 0).toFixed(1)}%</td><td>${(plan.cashAfter / plan.total * 100).toFixed(1)}%</td><td>${money(plan.cashAfter)} left</td></tr></tfoot>`;
  document.querySelectorAll('#tbl-targets input.num').forEach(inp => inp.addEventListener('change', () => {
    const v = Math.max(0, +inp.value || 0);
    // Store targets as percentages of the sum; others keep their share.
    const cur = Object.fromEntries(Object.entries(s.targets).map(([k, x]) => [k, (x / (tsum || 1)) * 100]));
    cur[inp.dataset.sym] = v;
    s.targets = cur; s.preset = 'custom';
    document.querySelectorAll('#reb-preset button').forEach(b => b.classList.toggle('on', b.dataset.preset === 'custom'));
    persist(); renderPlan(ctx);
  }));
  const sm = plan.summary;
  $('#reb-summary').innerHTML = [
    ['Orders', plan.trades.length, `${plan.trades.filter(t => t.side === 'SELL').length} sells · ${plan.trades.filter(t => t.side === 'BUY').length} buys`],
    ['Sell', money(sm.sells), 'at the last close'],
    ['Buy', money(sm.buys), 'at the last close'],
    ['Drift from target', `${(sm.drift * 100).toFixed(1)}%`, 'share of the portfolio in the wrong place today'],
  ].map(([t, v, n]) => `<div class="kpi"><dt>${t}</dt><dd>${v}</dd><div class="note">${n}</div></div>`).join('');
  $('#tbl-orders').innerHTML = plan.trades.length ? `<thead><tr><th class="l">Order</th><th>Qty</th><th>Last close</th><th>Value at last close</th></tr></thead><tbody>${plan.trades.map(t =>
    `<tr><td class="l"><span class="pill ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? 'Buy' : 'Sell'}</span> <b>${esc(t.symbol)}</b></td><td>${qtyFmt(t.qty)}</td><td>${money(t.price, 2)}</td><td>${money(t.value, 2)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="l muted">Nothing to trade: you are within the minimum order size of every target.</td></tr></tbody>';
}
export function initRebalanceControls(ctx) {
  const { $ } = ctx;
  document.querySelectorAll('#reb-preset button').forEach(b => b.addEventListener('click', () => {
    if (!ui) return;
    const p = b.dataset.preset;
    ui.settings.preset = p;
    if (p !== 'custom') ui.settings.targets = presetTargets(p, ctx.state.ledger.positions, ui.look.total);
    persist(); renderRebalance(ctx);
  }));
  const bind = (id, key, f = v => +v) => $(id).addEventListener('change', e => { if (!ui) return; ui.settings[key] = f(e.target.type === 'checkbox' ? e.target.checked : e.target.value); persist(); renderPlan(ctx); });
  bind('#reb-new', 'newMoney'); bind('#reb-cash', 'cashTarget'); bind('#reb-min', 'minTrade'); bind('#reb-frac', 'fractional', v => !!v);
  $('#reb-add').addEventListener('submit', e => {
    e.preventDefault();
    if (!ui) return;
    const sym = $('#reb-add-sym').value.trim().toUpperCase();
    const w = +$('#reb-add-w').value || 0;
    const px = +$('#reb-add-px').value || 0;
    const msg = $('#reb-add-msg');
    if (!sym) return;
    const known = ctx.state.book[sym];
    if (!known && !px) { msg.textContent = `No price data for ${sym}. Enter a price, or add it to data/tickers.json so the price workflow fetches it.`; return; }
    if (px) (ui.settings.manualPrices ||= {})[sym] = px;
    const tsum = Object.values(ui.settings.targets).reduce((a, x) => a + x, 0) || 1;
    const cur = Object.fromEntries(Object.entries(ui.settings.targets).map(([k, x]) => [k, (x / tsum) * 100]));
    cur[sym] = w; ui.settings.targets = cur; ui.settings.preset = 'custom';
    msg.textContent = `${sym} added with a ${w}% target.`;
    $('#reb-add-sym').value = ''; $('#reb-add-w').value = ''; $('#reb-add-px').value = '';
    persist(); renderRebalance(ctx);
  });
  $('#reb-copy').addEventListener('click', async () => {
    if (!ui?.plan) return;
    const text = ui.plan.trades.map(t => `${t.side} ${+t.qty.toFixed(4)} ${t.symbol} (last close ${t.price.toFixed(2)})`).join('\n') || 'No orders';
    const btn = $('#reb-copy');
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy orders'; }, 1600);
  });
}

/* ---------- Claude review ---------- */
function payload(ctx) {
  return aiPayload({ model: ctx.state.model, kpis: ctx.state.kpis, ledger: ctx.state.ledger, look: ui.look, overlaps: ui.overlaps, checks: ui.checks, plan: ui.plan, goals: ctx.$('#ai-goals').value.trim() });
}
function renderAiPanel(ctx) {
  const { $ } = ctx;
  $('#ai-goals').value = load(GOALS_KEY, '');
  $('#ai-payload').textContent = moneyHidden() ? 'Hidden while dollar amounts are hidden. Click Show $ to see it.' : JSON.stringify(payload(ctx), null, 1);
}
export function initAiControls(ctx) {
  const { $ } = ctx;
  $('#ai-key').addEventListener('input', e => { apiKey = e.target.value.trim(); });
  $('#ai-goals').addEventListener('change', e => { save(GOALS_KEY, e.target.value); if (ui) renderAiPanel(ctx); });
  $('#ai-form').addEventListener('submit', e => { e.preventDefault(); runReview(ctx); });
  $('#ai-copy').addEventListener('click', async () => {
    if (!ui) return;
    const text = `${AI_SYSTEM}\n\nReply with: a short summary, strengths, issues (with severity), concrete actions, and questions for me.\n\nPortfolio summary JSON:\n${JSON.stringify(payload(ctx))}`;
    const btn = $('#ai-copy');
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Prompt copied: paste it into claude.ai'; }
    catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy prompt for claude.ai'; }, 2500);
  });
}
async function runReview(ctx) {
  const { $, esc } = ctx;
  const out = $('#ai-out'), btn = $('#ai-run');
  if (!ui) return;
  if (!apiKey) { out.innerHTML = '<p class="warn-line">Paste an Anthropic API key first, or use "Copy prompt for claude.ai" instead.</p>'; return; }
  btn.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => { btn.textContent = `Reviewing… ${Math.round((Date.now() - started) / 1000)}s`; }, 500);
  out.innerHTML = '<p class="sub">Claude is reading your portfolio summary. This usually takes 20–60 seconds.</p>';
  try {
    const { default: Anthropic } = await import('./vendor/anthropic-sdk.mjs');
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: AI_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: `Portfolio summary JSON:\n${JSON.stringify(payload(ctx))}` }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error(`Claude declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}.`);
    if (msg.stop_reason === 'max_tokens') throw new Error('The review was cut off before it finished. Try again.');
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    renderReview(ctx, JSON.parse(text), msg);
  } catch (err) {
    const status = err?.status;
    const why = status === 401 ? 'The API key was rejected. Check that you copied the whole key (it starts with sk-ant-).'
      : status === 429 ? 'Rate limited or out of credit. Wait a minute or check your Anthropic console billing.'
      : status === 529 || status >= 500 ? 'Anthropic’s API is busy right now. Try again in a minute.'
      : err?.message || String(err);
    out.innerHTML = `<p class="warn-line">${esc(why)}</p>`;
  } finally {
    clearInterval(tick);
    btn.disabled = false; btn.textContent = 'Run AI review';
  }
}
function renderReview({ $, esc: escRaw }, r, msg) {
  lastReview = { r, msg };
  const esc = x => escRaw(maskText(x)); // free text from Claude: mask $ figures when hidden
  const sev = { high: 'Act', medium: 'Review', low: 'Note' };
  const act = { buy: 'Buy', add: 'Add', hold: 'Hold', trim: 'Trim', sell: 'Sell', replace: 'Replace', consolidate: 'Consolidate', other: 'Other' };
  const u = msg.usage || {};
  $('#ai-out').innerHTML = `
    <p class="ai-summary">${esc(r.summary)}</p>
    ${r.strengths?.length ? `<h3 class="h3">Strengths</h3><ul class="ai-list">${r.strengths.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${r.issues?.length ? `<h3 class="h3">Issues</h3><div class="findings">${r.issues.map(i => `<article class="finding f-${i.severity}"><span class="f-icon" aria-hidden="true">${SEV_ICON[i.severity] || 'i'}</span><div><div class="f-title"><span class="sev-pill sev-${i.severity}">${sev[i.severity] || i.severity}</span> ${esc(i.title)}</div><p>${esc(i.detail)}</p></div></article>`).join('')}</div>` : ''}
    ${r.actions?.length ? `<h3 class="h3">Suggested actions</h3><ul class="ai-actions">${r.actions.map(a => `<li><span class="pill src">${act[a.action] || esc(a.action)}</span> <b>${a.symbols.map(esc).join(', ')}</b> ${esc(a.rationale)}</li>`).join('')}</ul>` : ''}
    ${r.questions?.length ? `<h3 class="h3">Questions to answer</h3><ul class="ai-list">${r.questions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="sub">Model ${esc(msg.model)} · ${u.input_tokens ?? '?'} tokens in, ${u.output_tokens ?? '?'} out. Educational analysis, not personal financial advice.</p>`;
}

export { RULES };
