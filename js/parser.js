// Parser for Interactive Brokers "Activity Statement" CSV exports.
// Every row is `Section,RowType,...`; each section's Header row defines the
// columns of the Data rows that follow it (a section may re-declare its header).

export function tokenizeCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function num(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v).replace(/,/g, '').replace('%', '').trim();
  if (s === '' || s === '--') return NaN;
  return Number(s);
}

const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };

function parseLongDate(s) {
  // "May 27, 2025"
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || '');
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function symbolFromDescription(desc) {
  const m = /^([A-Z0-9.\- ]+?)\s*\(/.exec(desc || '');
  return m ? m[1].trim() : null;
}

// Groups rows by section: { name: [{type, rec}] } where rec maps header -> value.
function sectionize(rows) {
  const sections = {};
  const headers = {};
  for (const r of rows) {
    if (r.length < 2) continue;
    const name = r[0].trim();
    const type = r[1].trim();
    if (!name) continue;
    if (type === 'Header') { headers[name] = r.slice(2); continue; }
    const hdr = headers[name] || [];
    const rec = {};
    const vals = r.slice(2);
    vals.forEach((v, i) => { rec[hdr[i] || `_${i}`] = v; });
    rec._raw = vals;
    (sections[name] ||= []).push({ type, rec });
  }
  return sections;
}

export function parseStatement(text, fileName = '') {
  const rows = tokenizeCSV(text);
  const S = sectionize(rows);
  const get = (name, type = 'Data') => (S[name] || []).filter(x => x.type === type).map(x => x.rec);
  const kv = (name) => Object.fromEntries(get(name).map(r => [r['Field Name'], r['Field Value']]));

  const st = kv('Statement');
  const acct = kv('Account Information');
  if (!st.Title && !acct.Account) throw new Error(`${fileName || 'File'} does not look like an IBKR Activity Statement`);
  const [pStart, pEnd] = (st.Period || '').split(' - ');
  const meta = {
    fileName,
    title: st.Title,
    account: acct.Account,
    name: acct.Name,
    baseCcy: acct['Base Currency'] || 'USD',
    periodStart: parseLongDate(pStart),
    periodEnd: parseLongDate(pEnd || pStart),
    generated: st.WhenGenerated,
  };

  // Net Asset Value: first header = asset classes, second header = TWR.
  const nav = { start: NaN, end: NaN, twr: NaN, changes: {} };
  for (const r of get('Net Asset Value')) {
    if (r['Asset Class'] && r['Asset Class'].trim() === 'Total') {
      nav.start = num(r['Prior Total']);
      nav.end = num(r['Current Total']);
    }
    if (r['Time Weighted Rate of Return'] !== undefined) nav.twr = num(r['Time Weighted Rate of Return']) / 100;
  }
  for (const r of get('Change in NAV')) nav.changes[r['Field Name']] = num(r['Field Value']);
  if (!isFinite(nav.start) && isFinite(nav.changes['Starting Value'])) nav.start = nav.changes['Starting Value'];
  if (!isFinite(nav.end) && isFinite(nav.changes['Ending Value'])) nav.end = nav.changes['Ending Value'];

  // Trades (stocks, ETFs, forex conversions).
  const trades = [];
  for (const r of get('Trades')) {
    if (r.DataDiscriminator && r.DataDiscriminator !== 'Order' && r.DataDiscriminator !== 'Trade') continue;
    const cat = r['Asset Category'];
    const dt = (r['Date/Time'] || '').replace(',', '').trim();
    const t = {
      category: cat,
      kind: cat === 'Forex' ? 'forex' : 'security',
      ccy: r.Currency,
      symbol: r.Symbol,
      dt,
      date: dt.slice(0, 10),
      qty: num(r.Quantity),
      price: num(r['T. Price']),
      closePrice: num(r['C. Price']),
      proceeds: num(r.Proceeds),
      comm: num(r['Comm/Fee'] ?? r['Comm in USD']),
      commCcy: r['Comm in USD'] !== undefined ? 'USD' : r.Currency,
      basis: num(r.Basis),
      realized: num(r['Realized P/L']),
      code: r.Code || '',
    };
    if (!isFinite(t.comm)) t.comm = 0;
    if (!t.symbol || !isFinite(t.qty)) continue;
    trades.push(t);
  }

  // Deposits & withdrawals, with per-currency USD totals for FX scaling.
  const deposits = [];
  const depositTotals = {};
  let lastCcy = null;
  for (const r of get('Deposits & Withdrawals')) {
    const ccy = (r.Currency || '').trim();
    if (ccy === 'Total') { if (lastCcy) (depositTotals[lastCcy] ||= {}).native = num(r.Amount); continue; }
    if (ccy === 'Total in USD' || /^Total in/.test(ccy)) { if (lastCcy) (depositTotals[lastCcy] ||= {}).base = num(r.Amount); continue; }
    if (/^Total/.test(ccy)) continue;
    lastCcy = ccy;
    deposits.push({ ccy, date: r['Settle Date'], desc: r.Description, amount: num(r.Amount) });
  }

  const cashRows = (name, extra = {}) => get(name)
    .filter(r => r.Currency && !/^Total/.test(r.Currency) && r.Date)
    .map(r => ({ ccy: r.Currency, date: r.Date, desc: r.Description, amount: num(r.Amount), symbol: symbolFromDescription(r.Description), ...extra }));

  const dividends = cashRows('Dividends').map(d => ({ ...d, inLieu: /in Lieu/i.test(d.desc) }));
  const withholding = cashRows('Withholding Tax');
  const interest = cashRows('Interest');
  const fees = get('Fees')
    .filter(r => r.Currency && r.Date)
    .map(r => ({ ccy: r.Currency, date: r.Date, desc: r.Description, amount: num(r.Amount) }));

  const openPositions = get('Open Positions')
    .filter(r => r.DataDiscriminator === 'Summary')
    .map(r => ({
      symbol: r.Symbol, ccy: r.Currency, qty: num(r.Quantity), costPrice: num(r['Cost Price']),
      costBasis: num(r['Cost Basis']), closePrice: num(r['Close Price']), value: num(r.Value), unrealized: num(r['Unrealized P/L']),
    }));

  const mtm = get('Mark-to-Market Performance Summary')
    .filter(r => r.Symbol && r['Asset Category'] !== 'Total' && !/^Total/.test(r['Asset Category']))
    .map(r => ({
      category: r['Asset Category'], symbol: r.Symbol, priorQty: num(r['Prior Quantity']), qty: num(r['Current Quantity']),
      priorPrice: num(r['Prior Price']), price: num(r['Current Price']), total: num(r['Mark-to-Market P/L Total']),
    }));

  const instruments = {};
  for (const r of get('Financial Instrument Information')) {
    if (!r.Symbol) continue;
    instruments[r.Symbol] = { symbol: r.Symbol, name: r.Description, category: r['Asset Category'], type: r.Type, exchange: r['Listing Exch'], isin: r['Security ID'] };
  }

  // Corporate actions (splits, spin-offs); rarely present but important when they are.
  const corporateActions = get('Corporate Actions')
    .filter(r => r['Asset Category'] && !/^Total/.test(r['Asset Category']) && (r['Date/Time'] || r['Report Date']))
    .map(r => ({
      date: (r['Date/Time'] || r['Report Date']).slice(0, 10), desc: r.Description, symbol: symbolFromDescription(r.Description),
      qty: num(r.Quantity), proceeds: num(r.Proceeds) || 0, ccy: r.Currency,
    }));

  const cash = {};
  for (const r of get('Cash Report')) {
    if (r.Currency === 'Base Currency Summary') cash[r['Currency Summary']] = num(r.Total);
  }

  const accruals = (() => {
    const r = get('Net Asset Value').find(x => (x['Asset Class'] || '').trim() === 'Dividend Accruals');
    return r ? num(r['Current Total']) : 0;
  })();

  return { meta, nav, trades, deposits, depositTotals, dividends, withholding, interest, fees, openPositions, mtm, instruments, corporateActions, cash, accruals };
}
