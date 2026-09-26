// "Hide $" switch: when on, every dollar amount renders as $$$ (counts and percentages stay).
export const MASK = '$$$';
const KEY = 'stokkks.hideMoney';
let hidden = false;
try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable */ }

export const moneyHidden = () => hidden;
export function setMoneyHidden(v) {
  hidden = !!v;
  try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { /* storage unavailable */ }
}
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Plain-text dollar amount for sentences (findings, warnings).
export const usd = (v, d = 0) => hidden ? MASK : (v < 0 ? '−$' : '$') + (d ? nf2 : nf0).format(Math.abs(v));
// Masks dollar figures inside free text we did not format ourselves (e.g. the AI review).
export const maskText = s => hidden ? String(s).replace(/[−+-]?\$\s?\d[\d,]*(\.\d+)?(\s?[kKmMbB]\b)?/g, () => MASK) : s;
