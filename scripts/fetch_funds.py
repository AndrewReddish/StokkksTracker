#!/usr/bin/env python3
"""Refresh data/funds.json (ETF top holdings, sector weights, expense ratios; stock sector
and country) from Yahoo Finance for every symbol in data/tickers.json.

Curated fields that Yahoo does not provide well (fund region split, index, style) are kept.
Any symbol that fails keeps its previous entry, so a Yahoo outage never loses data.
Standard library only. Usage: python scripts/fetch_funds.py [SYMBOL ...]
"""
import datetime as dt
import http.cookiejar
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FUNDS = ROOT / "data" / "funds.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
EMERGING = {"China", "India", "Brazil", "Taiwan", "South Korea", "Mexico", "South Africa", "Indonesia",
            "Thailand", "Malaysia", "Saudi Arabia", "Turkey", "Chile", "Poland", "Philippines", "Hong Kong"}

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent", UA)]


def get(url):
    with opener.open(url, timeout=30) as r:
        return r.read()


def crumb():
    try:
        get("https://fc.yahoo.com")
    except Exception:  # noqa: BLE001 - this endpoint answers 404 but still sets the cookie
        pass
    return get("https://query2.finance.yahoo.com/v1/test/getcrumb").decode().strip()


def summary(sym, c):
    mods = "quoteType,topHoldings,fundProfile,assetProfile"
    url = f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(sym)}?modules={mods}&crumb={urllib.parse.quote(c)}"
    return json.loads(get(url))["quoteSummary"]["result"][0]


def raw(v):
    return v.get("raw") if isinstance(v, dict) else v


def sector_key(name):
    return (name or "").strip().lower().replace("real estate", "realestate").replace(" ", "_") or None


def update(entry, sym, res):
    qt = (res.get("quoteType") or {}).get("quoteType")
    name = (res.get("quoteType") or {}).get("longName") or entry.get("name") or sym
    today = dt.date.today().isoformat()
    if qt == "ETF":
        th = res.get("topHoldings") or {}
        holdings = [{"symbol": h.get("symbol") or h.get("holdingName"), "name": h.get("holdingName"), "weight": round(raw(h.get("holdingPercent")) or 0, 5)}
                    for h in th.get("holdings", []) if raw(h.get("holdingPercent"))]
        sectors = {}
        for item in th.get("sectorWeightings", []):
            for k, v in item.items():
                if raw(v):
                    sectors[k] = round(raw(v), 5)
        e = {**entry, "kind": "etf", "name": entry.get("name") or name}
        if holdings:
            e["holdings"] = holdings
        if sum(sectors.values()) > 0.5:
            e["sectors"] = sectors
        er = raw(((res.get("fundProfile") or {}).get("feesExpensesInvestment") or {}).get("annualReportExpenseRatio"))
        if er:
            e["expenseRatio"] = round(er * 100, 4)
        if "assetClass" not in e:
            bonds = raw(th.get("bondPosition")) or 0
            cash = raw(th.get("cashPosition")) or 0
            e["assetClass"] = "bond" if bonds > 0.5 else "cash" if cash > 0.5 else "equity"
        if "region" not in e:
            e["region"] = {"us": 1.0}
            e["regionGuess"] = True
    elif qt == "EQUITY":
        ap = res.get("assetProfile") or {}
        country = ap.get("country") or entry.get("country")
        region = "us" if country == "United States" else "emerging" if country in EMERGING else "developed"
        e = {**entry, "kind": "stock", "name": entry.get("name") or name, "assetClass": "equity",
             "sector": sector_key(ap.get("sector")) or entry.get("sector"), "country": country, "region": {region: 1.0}}
    else:
        raise ValueError(f"unsupported quote type {qt}")
    e["source"] = "yahoo"
    e["asOf"] = today
    return e


def main():
    data = json.loads(FUNDS.read_text())
    cfg = json.loads((ROOT / "data" / "tickers.json").read_text())
    wanted = sys.argv[1:] or sorted(set(cfg["symbols"]) | {"SPY", "QQQ"})
    try:
        c = crumb()
    except Exception as e:  # noqa: BLE001
        print(f"Yahoo session failed ({e}); keeping curated data", file=sys.stderr)
        return
    ok = 0
    for sym in wanted:
        try:
            res = summary(sym.replace(".", "-"), c)
            data["funds"][sym] = update(data["funds"].get(sym, {}), sym, res)
            ok += 1
            print(f"{sym}: {data['funds'][sym]['kind']} updated")
        except Exception as e:  # noqa: BLE001
            print(f"{sym}: kept previous entry ({e})", file=sys.stderr)
        time.sleep(0.4)
    data["funds"] = dict(sorted(data["funds"].items()))
    FUNDS.write_text(json.dumps(data, indent=1) + "\n")
    print(f"Updated {ok}/{len(wanted)} symbols")


if __name__ == "__main__":
    main()
