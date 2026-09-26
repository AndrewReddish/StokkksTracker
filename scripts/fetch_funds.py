#!/usr/bin/env python3
"""Fetch fund holdings and stock classifications into data/funds.json.

Only data published by a source is stored; nothing is estimated or filled in by hand.
- ETFs: the issuer's own holdings file (Vanguard, iShares, SPDR/SSGA, Invesco, Schwab),
  falling back to stockanalysis.com's holdings table (top holdings only, no sectors).
  Sector and region weights are sums of holding weights where the file gives a sector or
  country for each holding; the covered share is stored alongside.
- Stocks: sector, industry and country from Nasdaq's company profile.
Every attempt is recorded under "status" so the dashboard can show what loaded and what did not.
A symbol whose sources all fail keeps its previously fetched entry (with its original date).

Standard library only. Usage: python scripts/fetch_funds.py [SYMBOL ...]
"""
import csv
import datetime as dt
import html
import io
import json
import pathlib
import re
import sys
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
FUNDS = ROOT / "data" / "funds.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
MAX_HOLDINGS = 600

# Issuer for each ETF we know how to fetch. iShares needs its product page id and slug.
ISSUERS = {
    "VOO": "vanguard", "VTI": "vanguard", "VXUS": "vanguard", "VNQ": "vanguard", "BND": "vanguard", "VT": "vanguard", "VEA": "vanguard", "VWO": "vanguard",
    "IWM": ("ishares", "239710", "ishares-russell-2000-etf"),
    "SGOV": ("ishares", "314116", "ishares-0-3-month-treasury-bond-etf"),
    "IVV": ("ishares", "239726", "ishares-core-sp-500-etf"),
    "SPY": "ssga", "XLP": "ssga", "XBI": "ssga", "XLK": "ssga", "XLF": "ssga", "XLV": "ssga", "XLE": "ssga",
    "QQQ": "invesco", "QQQM": "invesco", "RSP": "invesco",
    "SCHD": "schwab", "SCHB": "schwab", "SCHX": "schwab",
}
# MSCI emerging-market countries; every other non-US country is treated as developed.
EMERGING = {"China", "India", "Brazil", "Taiwan", "Korea", "South Korea", "Korea (South)", "Mexico", "South Africa", "Indonesia", "Thailand",
            "Malaysia", "Saudi Arabia", "Turkey", "Chile", "Poland", "Philippines", "Qatar", "United Arab Emirates", "Kuwait", "Peru",
            "Hungary", "Greece", "Czech Republic", "Colombia", "Egypt"}
SECTORS = {
    "information technology": "technology", "technology": "technology", "it": "technology",
    "financials": "financials", "finance": "financials", "financial services": "financials",
    "health care": "healthcare", "healthcare": "healthcare",
    "consumer discretionary": "consumer_discretionary", "consumer cyclical": "consumer_discretionary",
    "consumer staples": "consumer_staples", "consumer defensive": "consumer_staples",
    "communication services": "communication", "communication": "communication", "communications": "communication", "telecommunications": "communication", "telecommunication services": "communication",
    "industrials": "industrials", "energy": "energy", "utilities": "utilities",
    "real estate": "real_estate", "materials": "materials", "basic materials": "materials",
}


def get(url, headers=None, tries=2):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise last


def num(v):
    try:
        return float(str(v).replace(",", "").replace("%", "").replace("$", "").strip())
    except ValueError:
        return None


def sector_key(name):
    if not name:
        return None
    return SECTORS.get(str(name).strip().lower())


def region_of(country):
    if not country:
        return None
    c = str(country).strip()
    if c in ("United States", "US", "USA", "United States of America"):
        return "us"
    return "emerging" if c in EMERGING else "developed"


def finish(holdings, name=None, expense=None, source=""):
    """Normalise holdings (weights as fractions), aggregate sectors/regions, keep the top MAX_HOLDINGS."""
    hs = [h for h in holdings if h.get("weight") and h["weight"] > 0]
    if not hs:
        raise ValueError("no holdings with weights")
    total = sum(h["weight"] for h in hs)
    if total > 1.5:  # file gave percentages
        for h in hs:
            h["weight"] /= 100
        total /= 100
    sectors, regions, sec_cov, reg_cov = {}, {}, 0.0, 0.0
    for h in hs:
        k = sector_key(h.get("sector"))
        if k:
            sectors[k] = sectors.get(k, 0) + h["weight"]
            sec_cov += h["weight"]
        r = region_of(h.get("country"))
        if r:
            regions[r] = regions.get(r, 0) + h["weight"]
            reg_cov += h["weight"]
    hs.sort(key=lambda h: -h["weight"])
    top = [{"symbol": (h.get("symbol") or "").strip() or None, "name": (h.get("name") or "").strip(), "weight": round(h["weight"], 6)} for h in hs[:MAX_HOLDINGS]]
    out = {
        "kind": "etf", "name": name, "source": source, "holdings": top, "holdingsCount": len(hs),
        "holdingsWeight": round(total, 4), "storedWeight": round(sum(h["weight"] for h in top), 4),
        "sectors": {k: round(v, 5) for k, v in sectors.items()}, "sectorCoverage": round(sec_cov, 4),
        "regions": {k: round(v, 5) for k, v in regions.items()}, "regionCoverage": round(reg_cov, 4),
    }
    if expense is not None:
        out["expenseRatio"] = expense
    return out


def pick(row, *names):
    low = {k.strip().lower(): v for k, v in row.items() if k}
    for n in names:
        if n in low and low[n] not in (None, ""):
            return low[n]
    return None


def csv_rows(text, must):
    """Find the header line containing `must` and parse the CSV from there."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if must.lower() in line.lower():
            return list(csv.DictReader(io.StringIO("\n".join(lines[i:]))))
    raise ValueError(f"header with {must!r} not found; starts: {text[:200]!r}")


def vanguard(sym):
    holdings = []
    for kind in ("stock", "bond"):
        start = 1
        while True:
            url = f"https://investor.vanguard.com/investment-products/etfs/profile/api/{sym}/portfolio-holding/{kind}?start={start}&count=500"
            try:
                j = json.loads(get(url, {"Accept": "application/json", "Referer": f"https://investor.vanguard.com/investment-products/etfs/profile/{sym.lower()}"}))
            except Exception as e:  # noqa: BLE001
                if kind == "bond":
                    break
                raise
            ents = (j.get("fund") or {}).get("entity") or []
            if start == 1 and ents:
                print(f"    vanguard {kind} fields: {sorted(ents[0].keys())}")
            for e in ents:
                holdings.append({"symbol": e.get("ticker"), "name": e.get("longName") or e.get("shortName"), "weight": num(e.get("percentWeight")),
                                 "sector": e.get("sectorName") or e.get("sector"), "country": e.get("countryName") or e.get("country")})
            size = j.get("size") or 0
            start += 500
            if not ents or start > size or start > 10000:
                break
    return finish(holdings, source="vanguard")


def ishares(sym, pid, slug):
    url = f"https://www.ishares.com/us/products/{pid}/{slug}/1467271812596.ajax?fileType=csv&fileName={sym}_holdings&dataType=fund"
    text = get(url).decode("utf-8-sig", "replace")
    rows = csv_rows(text, "Ticker,Name")
    hs = [{"symbol": pick(r, "ticker"), "name": pick(r, "name"), "weight": num(pick(r, "weight (%)")), "sector": pick(r, "sector"), "country": pick(r, "location")} for r in rows]
    return finish(hs, source="ishares")


def xlsx_rows(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    sheet = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))[0]
    rows = []
    for r in ET.fromstring(z.read(sheet)).iter(f"{{{ns['m']}}}row"):
        vals = {}
        for c in r.findall("m:c", ns):
            col = re.sub(r"\d", "", c.get("r"))
            v = c.find("m:v", ns)
            t = c.find("m:is/m:t", ns)
            val = shared[int(v.text)] if c.get("t") == "s" and v is not None else (v.text if v is not None else (t.text if t is not None else None))
            vals[col] = val
        rows.append(vals)
    return rows


def ssga(sym):
    url = f"https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{sym.lower()}.xlsx"
    rows = xlsx_rows(get(url))
    head_i = next(i for i, r in enumerate(rows) if any((v or "").strip().lower() == "ticker" for v in r.values()))
    head = {col: (v or "").strip().lower() for col, v in rows[head_i].items()}
    col = {name: c for c, name in head.items()}
    hs = []
    for r in rows[head_i + 1:]:
        w = num(r.get(col.get("weight")))
        if w is None:
            continue
        hs.append({"symbol": r.get(col.get("ticker")), "name": r.get(col.get("name")), "weight": w, "sector": r.get(col.get("sector"))})
    return finish(hs, source="ssga")


def invesco(sym):
    url = f"https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0?audienceType=Investor&action=download&ticker={sym}"
    text = get(url).decode("utf-8-sig", "replace")
    rows = csv_rows(text, "Holding Ticker")
    hs = [{"symbol": pick(r, "holding ticker"), "name": pick(r, "name"), "weight": num(pick(r, "weight")), "sector": pick(r, "sector")} for r in rows]
    return finish(hs, source="invesco")


def schwab(sym):
    page = get(f"https://www.schwabassetmanagement.com/allholdings/{sym}").decode("utf-8", "replace")
    hs = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(cells) >= 3:
            pct = next((num(c) for c in cells if c.endswith("%")), None)
            if pct is not None:
                hs.append({"symbol": cells[0], "name": cells[1], "weight": pct})
    if not hs:
        raise ValueError(f"no holdings table; page starts: {page[:200]!r}")
    return finish(hs, source="schwab")


def stockanalysis(sym):
    page = get(f"https://stockanalysis.com/etf/{sym.lower()}/holdings/").decode("utf-8", "replace")
    hs = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        pct = next((num(c) for c in cells if c.endswith("%")), None)
        if len(cells) >= 3 and pct is not None:
            # columns: No., Symbol, Name, % Weight, Shares
            hs.append({"symbol": cells[1], "name": cells[2], "weight": pct})
    if not hs:
        raise ValueError(f"no holdings table; page starts: {page[:200]!r}")
    return finish(hs, source="stockanalysis (top holdings only)")


def nasdaq_profile(sym):
    url = f"https://api.nasdaq.com/api/company/{sym}/company-profile"
    j = json.loads(get(url, {"Accept": "application/json", "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}))
    d = j.get("data") or {}
    if not d or not ((d.get("Sector") or {}).get("value")):
        raise ValueError(f"no sector in profile (not a stock?): {str(j)[:160]}")
    val = lambda k: ((d.get(k) or {}).get("value") or "").strip() or None  # noqa: E731
    address = val("Address") or ""
    country = address.replace("\r", "\n").split("\n")[-1].strip() if address else None
    if country and (len(country) > 40 or any(ch.isdigit() for ch in country)):
        country = None
    return {"kind": "stock", "name": val("CompanyName"), "sector": sector_key(val("Sector")), "sectorName": val("Sector"),
            "industry": val("Industry"), "country": country, "region": region_of(country), "regionName": val("Region"), "source": "nasdaq"}


def fetch(sym, kind_hint):
    attempts, errors = [], []
    tries = []
    iss = ISSUERS.get(sym)
    if kind_hint != "etf":
        tries.append(("nasdaq", lambda: nasdaq_profile(sym)))
    if iss:
        if isinstance(iss, tuple):
            tries.append((iss[0], lambda: ishares(sym, iss[1], iss[2])))
        else:
            tries.append((iss, lambda: globals()[iss](sym)))
    if kind_hint != "stock":
        tries.append(("stockanalysis", lambda: stockanalysis(sym)))
    for name, fn in tries:
        attempts.append(name)
        try:
            data = fn()
            return data, attempts, errors
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {type(e).__name__}: {str(e)[:240]}")
            print(f"    {sym} via {name} failed: {errors[-1]}", file=sys.stderr)
    return None, attempts, errors


def main():
    data = json.loads(FUNDS.read_text()) if FUNDS.exists() else {}
    data.setdefault("funds", {})
    data.setdefault("status", {})
    data.setdefault("aliases", {"GOOGL": "GOOG", "BRK-B": "BRK.B"})
    cfg = json.loads((ROOT / "data" / "tickers.json").read_text())
    wanted = sys.argv[1:] or sorted(set(cfg["symbols"]) | {"SPY", "QQQ"})
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    ok = 0
    for sym in wanted:
        prev = data["funds"].get(sym)
        hint = prev.get("kind") if prev else ("etf" if sym in ISSUERS else None)
        entry, attempts, errors = fetch(sym, hint)
        if entry:
            entry["asOf"] = now[:10]
            data["funds"][sym] = entry
            ok += 1
            detail = f"{entry.get('holdingsCount', '')} holdings" if entry["kind"] == "etf" else f"{entry.get('sectorName')} / {entry.get('country')}"
            print(f"{sym}: ok via {entry['source']} ({detail})")
        else:
            print(f"{sym}: FAILED ({'; '.join(errors)})")
        data["status"][sym] = {"ok": bool(entry), "checkedAt": now, "attempts": attempts, "errors": errors,
                               "source": (entry or prev or {}).get("source"), "dataAsOf": (entry or prev or {}).get("asOf")}
        time.sleep(0.5)
    data["updated"] = now
    data["funds"] = dict(sorted(data["funds"].items()))
    data["status"] = dict(sorted(data["status"].items()))
    FUNDS.write_text(json.dumps(data, indent=1) + "\n")
    print(f"Fetched {ok}/{len(wanted)} symbols")


if __name__ == "__main__":
    main()
