#!/usr/bin/env python3
"""Refresh the daily close cache in data/prices/ for every symbol in data/tickers.json.

Writes one JSON file per symbol: {"symbol", "currency", "updated", "dates", "close", "splits"}.
Closes are *unadjusted for splits* (they match the quantities on the broker statement)
and not adjusted for dividends (the dashboard books dividends as cash).
Sources: Yahoo Finance chart API, falling back to Stooq. Standard library only.

Usage: python scripts/fetch_prices.py [SYMBOL ...]
"""
import csv
import datetime as dt
import io
import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "prices"
UA = {"User-Agent": "Mozilla/5.0 (StokkksTracker price cache)"}
BENCHMARKS = ["SPY", "QQQ"]


def http_get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))
            print(f"  retry {url}: {e}", file=sys.stderr)


def yahoo(ysym, start):
    p1 = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp())
    p2 = int(time.time()) + 86400
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}"
           f"?period1={p1}&period2={p2}&interval=1d&events=split&includeAdjustedClose=false")
    j = json.loads(http_get(url))
    res = j["chart"]["result"][0]
    tz = res["meta"].get("gmtoffset", 0)
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0]["close"]
    dates, close = [], []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        d = dt.datetime.fromtimestamp(t + tz, dt.timezone.utc).date().isoformat()
        if dates and dates[-1] == d:
            close[-1] = c
            continue
        dates.append(d)
        close.append(c)
    splits = []
    for s in (res.get("events", {}) or {}).get("splits", {}).values():
        d = dt.datetime.fromtimestamp(s["date"] + tz, dt.timezone.utc).date().isoformat()
        splits.append({"date": d, "ratio": s["numerator"] / s["denominator"]})
    splits.sort(key=lambda s: s["date"])
    # Yahoo closes are split-adjusted: undo that so prices match statement quantities.
    for s in splits:
        close = [c * s["ratio"] if d < s["date"] else c for d, c in zip(dates, close)]
    return {"currency": res["meta"].get("currency"), "dates": dates, "close": close, "splits": splits, "source": "yahoo"}


def stooq(sym, start):
    s = sym.lower().replace(".", "-")
    s = s[:-2] if s.endswith("=x") else s + ".us"
    raw = http_get(f"https://stooq.com/q/d/l/?s={s}&i=d&d1={start.replace('-', '')}").decode()
    rows = list(csv.DictReader(io.StringIO(raw)))
    if not rows or "Close" not in rows[0]:
        raise ValueError(f"stooq: no data for {sym}")
    return {"currency": None, "dates": [r["Date"] for r in rows], "close": [float(r["Close"]) for r in rows],
            "splits": [], "source": "stooq"}


def fetch(name, ysym, start):
    try:
        data = yahoo(ysym, start)
    except Exception as e:  # noqa: BLE001
        print(f"  yahoo failed for {ysym}: {e}; trying stooq", file=sys.stderr)
        data = stooq(ysym, start)
    data = {"symbol": name, "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), **data}
    data["close"] = [round(c, 6) for c in data["close"]]
    return data


def main():
    cfg = json.loads((ROOT / "data" / "tickers.json").read_text())
    start = cfg.get("start", "2025-01-01")
    wanted = sys.argv[1:] or sorted(set(cfg["symbols"]) | set(BENCHMARKS))
    jobs = [(s, s.replace(".", "-")) for s in wanted]
    if not sys.argv[1:]:
        jobs += [(f"FX_{c}", f"{c}USD=X") for c in cfg.get("fx", [])]
    OUT.mkdir(parents=True, exist_ok=True)
    failed = []
    for name, ysym in jobs:
        try:
            data = fetch(name, ysym, start)
            (OUT / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")))
            print(f"{name}: {len(data['dates'])} days, last {data['dates'][-1]} = {data['close'][-1]} ({data['source']})")
        except Exception as e:  # noqa: BLE001
            failed.append(name)
            print(f"{name}: FAILED {e}", file=sys.stderr)
        time.sleep(0.5)
    manifest = sorted(p.stem for p in OUT.glob("*.json") if p.stem != "index")
    (OUT / "index.json").write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "symbols": manifest}))
    if failed and len(failed) == len(jobs):
        sys.exit(1)


if __name__ == "__main__":
    main()
