# Stokkks Tracker

Private portfolio analytics for **Interactive Brokers Activity Statements**. Drop your CSV statements into the page, and it rebuilds the whole history of the account in your browser. The files are never uploaded anywhere.

What you get:

- **Value against money deposited**: daily portfolio value vs cumulative net deposits, with each transfer marked. Once prices are cached, it also shows what the same deposits would be worth in the S&P 500.
- **Returns**: time-weighted return (checked against IBKR's own figure), money-weighted IRR, drawdown, monthly and yearly returns, and a comparison with SPY and QQQ.
- **Holdings**: allocation, average cost, unrealized/realized P/L, dividends, and per-position IRR.
- **Position history**: a price chart with every buy ▲ and sell ▼ marked (sized by amount) and the average-cost line, plus position value vs cost basis over time.
- **Closed positions**, **dividend income**, **a breakdown of where the gain came from** (price, dividends, tax, costs), a **reconciliation** against the statement NAV, and the full **trade log**.

## Use it

1. In IBKR: *Performance & Reports → Statements → Activity*, choose an Annual or Custom period, and set the format to **CSV**. Download as many periods as you like. Overlaps are de-duplicated.
2. Open the dashboard (GitHub Pages, or locally with `python3 -m http.server` in this folder and then <http://localhost:8000>).
3. Click **Add statements** or drag the files onto the page. The data stays in the browser's local storage until you click **Forget data**.

> Statements contain personal data. `.gitignore` blocks `*.csv` everywhere except `demo/`, so never commit your own.

## Demo

Click **Show demo report** on the start screen, or open the site with `#demo` at the end of the URL, to see the full report for a fictional 2026 account. It uses the same tickers as a real portfolio, made-up deposits and trades, and real daily closes. The demo is never saved, and **Exit demo** returns you to your own data. You can download the sample file (`demo/demo-statement-2026.csv`) to see the expected CSV format.

To regenerate it after the price cache updates, run `node tools/make_demo.mjs`. The output is deterministic, and the script runs the dashboard's own engine to fill in the statement's NAV, TWR and open positions, so the reconciliation always matches.

## Daily prices

The page reads daily closes from `data/prices/<SYMBOL>.json`. The **Refresh price cache** GitHub Action (`.github/workflows/prices.yml`) keeps them up to date. It runs every weekday after the US close, on manual dispatch, and whenever `data/tickers.json` changes.

- When you buy something new, add its ticker to `data/tickers.json` and push. The workflow fetches its history.
- Without a cached price file, a symbol's chart falls back to prices taken from the statements themselves (each trade day's close and the period-end marks) joined by straight lines. The totals stay exact either way.
- The cache stores closes that are not split-adjusted, so they match the share quantities on the statements. Dividends are counted as cash, not folded into prices.

## Publish on GitHub Pages

*Settings → Pages → Build and deployment → Deploy from a branch → `main` / root.* The site is static (plain HTML, CSS and ES modules, with ECharts vendored in `js/vendor/`), so it needs no build step.

## Command line

```
node tools/analyze.mjs ~/Downloads/U1234567_2025.csv ~/Downloads/U1234567_2026.csv
```

This prints the same KPIs, the reconciliation, and a per-position table.

## How the numbers are built

| Piece | Method |
| --- | --- |
| Parsing | `js/parser.js` reads every section of the multi-section IBKR CSV (Trades, Deposits & Withdrawals, Dividends, Withholding Tax, Interest, Fees, Open Positions, Mark-to-Market summary, NAV, Corporate Actions). |
| Merging | `js/merge.js` combines statements chronologically and keeps each distinct row once, even when periods overlap. |
| Ledger | `js/ledger.js` replays each day: cash per currency, EUR→USD conversions, FIFO lots aligned to IBKR's cost basis, dividends and tax per symbol. Non-USD deposits use IBKR's own "Total in USD" conversion. |
| Returns | `js/metrics.js` computes the daily-linked TWR (flows at the start of the day), XIRR on deposits, drawdown, and the "same deposits in SPY" benchmark. |
| Prices | `js/prices.js` uses the cached daily closes, falling back to statement anchor prices. |
