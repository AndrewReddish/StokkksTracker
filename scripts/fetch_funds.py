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
import os
import io
import json
import pathlib
import re
import sys
import time
import urllib.error
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
    "miscellaneous": "other",
}
# Listing-exchange prefixes used by stockanalysis.com for non-US holdings (e.g. "TPE: 2330").
EXCHANGE_COUNTRY = {
    "TPE": "Taiwan", "TWO": "Taiwan", "KRX": "Korea", "KOSDAQ": "Korea", "TYO": "Japan", "HKG": "Hong Kong", "SHA": "China", "SHE": "China",
    "LON": "United Kingdom", "EPA": "France", "ETR": "Germany", "FRA": "Germany", "AMS": "Netherlands", "SWX": "Switzerland", "BIT": "Italy",
    "BME": "Spain", "STO": "Sweden", "CPH": "Denmark", "HEL": "Finland", "OSL": "Norway", "EBR": "Belgium", "ELI": "Portugal", "VIE": "Austria",
    "ISE": "Ireland", "TSX": "Canada", "TSXV": "Canada", "ASX": "Australia", "NZE": "New Zealand", "SGX": "Singapore", "NSE": "India", "BOM": "India",
    "BVMF": "Brazil", "BMV": "Mexico", "JSE": "South Africa", "IDX": "Indonesia", "SET": "Thailand", "KLSE": "Malaysia", "TADAWUL": "Saudi Arabia",
    "IST": "Turkey", "WSE": "Poland", "TLV": "Israel", "PSE": "Philippines", "QSE": "Qatar", "ADX": "United Arab Emirates", "DFM": "United Arab Emirates",
    "SNSE": "Chile", "BVC": "Colombia", "ATH": "Greece", "BUD": "Hungary", "PRG": "Czech Republic", "KWSE": "Kuwait", "EGX": "Egypt", "BVL": "Peru",
}
# SEC EDGAR requires a User-Agent with a contact e-mail. Set SEC_CONTACT to your own address
# (e.g. as a repository variable); the default is GitHub Actions' generic no-reply address.
SEC_UA = "StokkksTracker " + (os.environ.get("SEC_CONTACT") or "41898282+github-actions[bot]@users.noreply.github.com")
_sec_map = None
_sec_down = None  # first error; after it SEC is skipped for the rest of the run


def sec_country(sym):
    """Country of a company's business address from its SEC filings."""
    global _sec_map, _sec_down
    if _sec_down:
        raise RuntimeError(f"SEC skipped this run ({_sec_down})")
    if _sec_map is None:
        j = json.loads(get("https://www.sec.gov/files/company_tickers.json", {"User-Agent": SEC_UA}))
        _sec_map = {v["ticker"].upper(): int(v["cik_str"]) for v in j.values()}
    cik = (_sec_map or {}).get(sym.upper().replace(".", "-")) or (_sec_map or {}).get(sym.upper())
    if not cik:
        raise ValueError("ticker not in SEC company list")
    sub = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", {"User-Agent": SEC_UA}))
    biz = (sub.get("addresses") or {}).get("business") or {}
    time.sleep(0.15)  # SEC fair-access limit is 10 requests a second
    if str(biz.get("isForeignLocation")) in ("1", "True", "true"):
        c = (biz.get("stateOrCountryDescription") or "").strip()
        return c.title() if c.isupper() else c or None
    return "United States" if biz.get("stateOrCountry") else None


def get(url, headers=None, tries=2):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise
            last = e
            time.sleep(2 * (i + 1))
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
            raw = get(url, {"Accept": "application/json, text/plain, */*", "Referer": f"https://investor.vanguard.com/investment-products/etfs/profile/{sym.lower()}"})
            try:
                j = json.loads(raw)
            except ValueError:
                if kind == "bond" and holdings:
                    break
                raise ValueError(f"not JSON; starts: {raw[:160]!r}")
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
    text = get(url, {"Accept": "text/csv,application/octet-stream,*/*", "Referer": f"https://www.ishares.com/us/products/{pid}/{slug}"}).decode("utf-8-sig", "replace")
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
    print(f"    ssga {sym} columns: {sorted(head.values())}")
    col = {name: c for c, name in head.items()}
    hs = []
    for r in rows[head_i + 1:]:
        w = num(r.get(col.get("weight")))
        if w is None:
            continue
        hs.append({"symbol": r.get(col.get("ticker")), "name": r.get(col.get("name")), "weight": w, "sector": r.get(col.get("sector"))})
    return finish(hs, source="ssga")


def invesco(sym):
    try:
        j = json.loads(get(f"https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/{sym}/holdings/fund?idType=ticker&interval=monthly&productType=ETF", {"Accept": "application/json"}))
        items = j.get("holdings") or []
        if items:
            print(f"    invesco fields: {sorted(items[0].keys())}")
            hs = [{"symbol": h.get("ticker"), "name": h.get("issuerName") or h.get("name"), "weight": num(h.get("percentageOfTotalNetAssets") or h.get("weight")),
                   "sector": h.get("gicsSectorDescription") or h.get("sector"), "country": h.get("countryOfRisk") or h.get("country")} for h in items]
            return finish(hs, source="invesco")
    except Exception as e:  # noqa: BLE001
        print(f"    invesco api failed: {e}", file=sys.stderr)
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
    country, country_src = None, None
    global _sec_down
    try:
        country, country_src = sec_country(sym), "sec"
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) and not _sec_down:
            _sec_down = f"HTTP {e.code}"
            print(f"    SEC refused ({e}); skipping SEC for the rest of this run", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"    {sym}: no SEC country ({e})", file=sys.stderr)
    return {"kind": "stock", "name": val("CompanyName"), "sector": sector_key(val("Sector")), "sectorName": val("Sector"), "sectorSource": "nasdaq",
            "industry": val("Industry"), "country": country, "countrySource": country_src, "region": region_of(country), "source": "nasdaq" + (" + sec" if country_src else "")}


def classify_holdings(entry, cache):
    """Add sector/region weights from each top holding's own profile when the fund file had none."""
    if entry.get("kind") != "etf":
        return entry
    need_sector = entry.get("sectorCoverage", 0) < 0.5
    need_region = entry.get("regionCoverage", 0) < 0.5
    if not (need_sector or need_region):
        return entry
    sectors, regions, sc, rc = {}, {}, 0.0, 0.0
    for h in entry["holdings"][:40]:
        sym = (h.get("symbol") or "").strip()
        if not sym or sym.lower() == "n/a":
            continue
        info = None
        if ":" in sym:  # foreign listing: country from the exchange, no sector lookup
            country = EXCHANGE_COUNTRY.get(sym.split(":")[0].strip())
            info = {"country": country, "sector": None}
        elif re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,6}", sym):
            info = cache.get(sym)
            if info is not None and info.get("checked", "") < (dt.date.today() - dt.timedelta(days=30)).isoformat():
                info = None  # refresh monthly
            if info is None:
                try:
                    p = nasdaq_profile(sym)
                    info = {"sector": p.get("sector"), "country": p.get("country"), "checked": dt.date.today().isoformat()}
                except Exception as e:  # noqa: BLE001
                    info = {"sector": None, "country": None, "error": str(e)[:120], "checked": dt.date.today().isoformat()}
                cache[sym] = info
                time.sleep(0.2)
        if not info:
            continue
        if need_sector and info.get("sector"):
            sectors[info["sector"]] = sectors.get(info["sector"], 0) + h["weight"]
            sc += h["weight"]
        r = region_of(info.get("country"))
        if need_region and r:
            regions[r] = regions.get(r, 0) + h["weight"]
            rc += h["weight"]
    if need_sector and sc > entry.get("sectorCoverage", 0):
        entry["sectors"] = {k: round(v, 5) for k, v in sectors.items()}
        entry["sectorCoverage"] = round(sc, 4)
        entry["sectorSource"] = "holdings' Nasdaq profiles"
    if need_region and rc > entry.get("regionCoverage", 0):
        entry["regions"] = {k: round(v, 5) for k, v in regions.items()}
        entry["regionCoverage"] = round(rc, 4)
        entry["regionSource"] = "holdings' SEC addresses / listing exchanges"
    return entry


def etf_profile(sym):
    """Asset class and expense ratio from the fund's stockanalysis.com overview page."""
    page = get(f"https://stockanalysis.com/etf/{sym.lower()}/").decode("utf-8", "replace")
    text = re.sub(r"\|+", "|", re.sub(r"<[^>]+>", "|", page))
    out = {}
    m = re.search(r"\|Asset Class\|\s*([^|]{2,40}?)\s*\|", text)
    if m:
        out["assetClassName"] = html.unescape(m.group(1)).strip()
        low = out["assetClassName"].lower()
        out["assetClass"] = "bond" if ("fixed" in low or "bond" in low) else "equity" if "equity" in low else "real_estate" if "real estate" in low else "cash" if "cash" in low or "money" in low else "other"
    m = re.search(r"\|Expense Ratio\|\s*([0-9.]+)%\s*\|", text)
    if m:
        out["expenseRatio"] = float(m.group(1))
    if not out:
        i = text.find("Expense")
        raise ValueError(f"fields not found; near 'Expense': {text[max(0, i - 80):i + 120]!r}")
    return out


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
    holding_cache = data.setdefault("holdingProfiles", {})  # reused across runs, refreshed monthly
    for sym in wanted:
        prev = data["funds"].get(sym)
        hint = prev.get("kind") if prev else ("etf" if sym in ISSUERS else None)
        entry, attempts, errors = fetch(sym, hint)
        if entry:
            entry.setdefault("sectorSource", entry.get("source") if entry.get("sectorCoverage") else None)
            entry.setdefault("regionSource", entry.get("source") if entry.get("regionCoverage") else None)
            entry = classify_holdings(entry, holding_cache)
            if entry.get("kind") == "etf":
                try:
                    prof = etf_profile(sym)
                    entry.update({k: v for k, v in prof.items() if k not in entry or k == "assetClass"})
                    entry["profileSource"] = "stockanalysis"
                except Exception as e:  # noqa: BLE001
                    errors.append(f"profile: {type(e).__name__}: {str(e)[:200]}")
                    print(f"    {sym} profile failed: {errors[-1]}", file=sys.stderr)
            entry["asOf"] = now[:10]
            data["funds"][sym] = entry
            ok += 1
            detail = f"{entry.get('holdingsCount', '')} holdings" if entry["kind"] == "etf" else f"{entry.get('sectorName')} / {entry.get('country')}"
            print(f"{sym}: ok via {entry['source']} ({detail})")
        else:
            print(f"{sym}: FAILED ({'; '.join(errors)})")
        data["status"][sym] = {"ok": bool(entry), "checkedAt": now, "attempts": attempts, "errors": errors,
                               "source": (entry or prev or {}).get("source"), "dataAsOf": (entry or prev or {}).get("asOf")}
        save(data, now)
        time.sleep(0.5)
    save(data, now)
    print(f"Fetched {ok}/{len(wanted)} symbols")


def save(data, now):
    """Written after every symbol so a timeout keeps what was fetched."""
    data["updated"] = now
    data["funds"] = dict(sorted(data["funds"].items()))
    data["status"] = dict(sorted(data["status"].items()))
    FUNDS.write_text(json.dumps(data, indent=1) + "\n")


if __name__ == "__main__":
    main()
