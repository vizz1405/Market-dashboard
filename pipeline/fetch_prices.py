"""Refresh data/prices/*.csv from Yahoo Finance (adjusted daily closes, same source as before).
Keeps the existing file if a download fails or looks short, so a bad morning never wipes history.
Usage: python3 pipeline/fetch_prices.py [data_dir]
"""
import sys, os, time, json, urllib.request
import pandas as pd

D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "data", "prices")
FILES = {
    "sp500.csv": "^GSPC", "nyse_composite.csv": "^NYA", "nasdaq_composite.csv": "^IXIC",
    "sti.csv": "^STI", "shanghai_composite.csv": "000001.SS", "shenzhen_component.csv": "399001.SZ",
    "es3_spdr_sti_etf.csv": "ES3.SI", "a35_abf_sg_bond_etf.csv": "A35.SI", "mbh_nikko_sgd_ig_bond_etf.csv": "MBH.SI",
}
UA = {"User-Agent": "Mozilla/5.0"}


def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            print("retry", url, e)
            time.sleep(2 ** i * 3)
    raise RuntimeError(url)


def daily(sym):
    q = urllib.request.quote(sym)
    j = get(f"https://query2.finance.yahoo.com/v8/finance/chart/{q}?period1=-1500000000&period2={int(time.time())}"
            f"&interval=1d&events=div%7Csplit&includeAdjustedClose=true")["chart"]["result"][0]
    tz = j["meta"].get("exchangeTimezoneName", "UTC")
    ind = j["indicators"]
    close = (ind.get("adjclose") or [{}])[0].get("adjclose") or ind["quote"][0]["close"]
    idx = pd.to_datetime(j["timestamp"], unit="s", utc=True).tz_convert(tz).date
    s = pd.Series(close, index=pd.to_datetime(idx), dtype=float).dropna()
    s = s[s > 0]
    return s[~s.index.duplicated(keep="last")].sort_index()


def tbill():
    j = get("https://query2.finance.yahoo.com/v8/finance/chart/%5EIRX?period1=0&period2="
            f"{int(time.time())}&interval=1d")["chart"]["result"][0]
    s = pd.Series(j["indicators"]["quote"][0]["close"], index=pd.to_datetime(j["timestamp"], unit="s"), dtype=float).dropna()
    return s.resample("ME").mean().dropna()


for f, sym in FILES.items():
    path = os.path.join(D, f)
    try:
        new = daily(sym)
        old = pd.read_csv(path, index_col=0, parse_dates=True)["close"] if os.path.exists(path) else pd.Series(dtype=float)
        if len(new) < 0.95 * len(old):
            print(f"{f}: short download ({len(new)} vs {len(old)}), keeping old file")
            continue
        new.rename("close").rename_axis("date").to_csv(path)
        print(f, sym, len(new), new.index[-1].date())
    except Exception as e:
        print(f"{f}: failed ({e}), keeping old file")

try:
    tb = tbill()
    path = os.path.join(D, "us_tbill_3m_monthly.csv")
    old = pd.read_csv(path, index_col=0, parse_dates=True)["rate"]
    if len(tb) >= 0.95 * len(old):
        tb[tb.index >= "1970-01-01"].rename("rate").rename_axis("date").to_csv(path)
        print("tbill", len(tb))
except Exception as e:
    print("tbill failed", e)

# Research tickers: two years of daily closes for the research charts (not used by any rule)
try:
    R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data", "research.json")))
    os.makedirs(os.path.join(D, "stocks"), exist_ok=True)
    for t in R["tickers"]:
        try:
            s = daily(t["yahoo"])
            s = s[s.index >= s.index[-1] - pd.Timedelta(days=760)]
            s.rename("close").rename_axis("date").to_csv(os.path.join(D, "stocks", t["ticker"] + ".csv"))
            print(t["ticker"], len(s), s.index[-1].date())
        except Exception as e:
            print(t["ticker"], "failed", e)
except Exception as e:
    print("research tickers skipped", e)
