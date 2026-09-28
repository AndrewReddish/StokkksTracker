// "Costs outside IBKR" panel: deposit commission and tax paid, entered by the user.
// Inputs are rendered once per analysis; typing only refreshes the computed cells so
// the field being edited keeps its focus.
import { MASK, moneyHidden } from './privacy.js';

const fmtNum = v => isFinite(v) ? String(+(+v).toFixed(2)) : '';

export function renderCosts(ctx) {
  const { $, esc, money } = ctx;
  const { costs } = ctx.state;
  const s = costs.settings;
  $('#oc-dep-pct').value = fmtNum(s.depositPct);
  $('#oc-tax-rate').value = fmtNum(s.taxRate);
  const date = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  $('#tbl-oc-deps').innerHTML = costs.deposits.length
    ? `<thead><tr><th class="l">Date</th><th>Amount</th><th>In ${esc(ctx.state.model.baseCcy)}</th><th>Commission %</th><th>Commission</th></tr></thead><tbody>${costs.deposits.map(d =>
      `<tr><td class="l">${date(d.date)}</td><td>${moneyHidden() ? MASK : esc(d.ccy) + ' ' + Math.round(d.amount).toLocaleString('en-US')}</td><td>${money(d.base)}</td>
        <td><input class="num" type="number" min="0" max="20" step="0.1" inputmode="decimal" data-dep="${esc(d.key)}" value="${d.overridden ? fmtNum(d.pct) : ''}" placeholder="${fmtNum(s.depositPct)}" aria-label="Commission % on ${date(d.date)}"></td>
        <td data-dep-fee="${esc(d.key)}"></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="l muted wrap">No incoming deposits in these statements.</td></tr></tbody>';
  const hidden = moneyHidden();
  $('#tbl-oc-tax').innerHTML = costs.tax.length
    ? `<thead><tr><th class="l">Year</th><th>Realized gains</th><th>Dividends</th><th>Withheld by IBKR</th><th>Estimate</th><th>Tax you paid</th></tr></thead><tbody>${costs.tax.map(t =>
      `<tr><td class="l">${t.year}</td><td>${ctx.signed(t.realized)}</td><td>${money(t.dividends)}</td><td>${money(-t.withheld)}</td><td data-tax-est="${t.year}"></td>
        <td><input class="num num-wide" type="${hidden ? 'text' : 'number'}" min="0" step="1" inputmode="decimal" data-tax="${t.year}" ${hidden ? `disabled value="${isFinite(t.entered) ? MASK : ''}" placeholder="${MASK}" title="Show $ to edit"` : `value="${fmtNum(t.entered)}"`} aria-label="Tax paid for ${t.year}"></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="l muted wrap">No completed tax year in these statements yet. A year appears here once the data runs past its 31 December.</td></tr></tbody>';
  updateCosts(ctx);
}

// Refreshes everything derived from the settings, leaving the inputs alone.
export function updateCosts(ctx) {
  const { $, money, signed, pct, cls } = ctx;
  const { costs, kpis: k } = ctx.state;
  for (const d of costs.deposits) {
    const cell = document.querySelector(`[data-dep-fee="${CSS.escape(d.key)}"]`);
    if (cell) cell.textContent = money(d.fee, 2);
    const inp = document.querySelector(`input[data-dep="${CSS.escape(d.key)}"]`);
    if (inp) inp.placeholder = fmtNum(costs.settings.depositPct);
  }
  const overrides = costs.deposits.filter(d => d.overridden).length;
  $('#oc-dep-summary').textContent = `Rate per deposit (${costs.deposits.length} transfer${costs.deposits.length === 1 ? '' : 's'}${overrides ? `, ${overrides} set individually` : ''})`;
  for (const t of costs.tax) {
    const cell = document.querySelector(`[data-tax-est="${t.year}"]`);
    if (cell) { cell.textContent = money(t.estimate); cell.className = t.isEstimate ? '' : 'est'; }
    const inp = document.querySelector(`input[data-tax="${t.year}"]`);
    if (inp && !moneyHidden()) inp.placeholder = `≈ ${Math.round(t.estimate)}`;
  }
  const estYears = costs.tax.filter(t => t.isEstimate && t.estimate > 0).map(t => t.year);
  const items = [
    ['Deposit commission', money(-k.depositFees), `${costs.deposits.length} transfer${costs.deposits.length === 1 ? '' : 's'} in`],
    ['Tax paid', money(-k.taxPaid), estYears.length ? `estimated for ${estYears.join(', ')}` : costs.tax.length ? 'as entered' : 'no completed year'],
    ['Profit before these', `<span class="${cls(k.gainBefore)}">${signed(k.gainBefore)}</span>`, `${pct(k.netDeposits ? k.gainBefore / k.netDeposits : NaN)} of deposits`],
    ['Profit after these', `<span class="${cls(k.gain)}">${signed(k.gain)}</span>`, `${pct(k.gainPct)} of ${money(k.netDeposits + k.depositFees)} put in`],
  ];
  $('#oc-summary').innerHTML = items.map(([t, v, n]) => `<div class="kpi"><dt>${t}</dt><dd>${v}</dd><div class="note">${n}</div></div>`).join('');
}

// onChange(mutator) receives a function that edits the settings object in place.
export function initCostControls(ctx, onChange) {
  const val = el => el.value.trim() === '' ? null : +el.value;
  document.getElementById('outside').addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'oc-dep-pct') onChange(s => { s.depositPct = val(el) ?? 0; });
    else if (el.id === 'oc-tax-rate') onChange(s => { s.taxRate = val(el) ?? 0; });
    else if (el.dataset.dep) onChange(s => { if (val(el) === null) delete s.depositOverrides[el.dataset.dep]; else s.depositOverrides[el.dataset.dep] = val(el); });
    else if (el.dataset.tax) onChange(s => { if (val(el) === null) delete s.taxPaid[el.dataset.tax]; else s.taxPaid[el.dataset.tax] = val(el); });
  });
}
