"""Turns the project's existing analysis into the dashboard's JSON.

Nothing here changes a rule. It calls the project's own code as it stands:
  - signals.py  (rules, backtests, bear capture, nowcast), with cash at 0.5 x US 3m T-bill (SGD deposit proxy),
                exactly as `python3 signals.py <name> <csv> <start> sgd` produced signals/out_sgd_cash/
  - corr.py     (odds that a 5/10/15% dip from a 1-year high becomes a 20% bear)
  - build.py    (daily 20% bull/bear phase history, current phase, summary, funds)
and only adds presentation: chart series, flip levels for the coming month end, alerts and plain-English takeaways.

Usage: python3 pipeline/make_site_data.py <prices_dir> <out_dir>
"""
import sys, os, json, subprocess, tempfile, shutil, datetime as dt
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
D, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(OUT, exist_ok=True)

import signals as S  # noqa: E402
_argv = sys.argv; sys.argv = [sys.argv[0]]
import corr as C  # noqa: E402  (its module body prints {} when given no names; harmless)
sys.argv = _argv

# name, file, start for backtests, display, region, headline rule, role
MARKETS = [
    ("sp500", "S&P 500", "US", "1970-01-01", "Dual: SMA and momentum both negative", "Decides when to sell all US holdings (NASDAQ and NYSE stocks)"),
    ("nasdaq_composite", "NASDAQ Composite", "US", None, "10m SMA (~200 day)", "Watch only. US sells follow the S&P 500 rule"),
    ("nyse_composite", "NYSE Composite", "US", None, "10m SMA (~200 day)", "Watch only. US sells follow the S&P 500 rule"),
    ("sti", "Straits Times Index", "SG", None, "10m SMA (~200 day)", "Decides when to sell SGX holdings"),
    ("shanghai_composite", "Shanghai Composite", "CN", None, "10m SMA (~200 day)", "Decides when to sell China A holdings (SSE and SZSE)"),
    ("shenzhen_component", "Shenzhen Component", "CN", None, "10m SMA (~200 day)", "Watch only. China sells follow the Shanghai rule"),
    ("es3_spdr_sti_etf", "SPDR STI ETF (ES3)", "SG", None, "10m SMA (~200 day)", "Watch only. Tradable STI fund, includes dividends"),
]
PLAN = {"sp500": "US", "sti": "SGX", "shanghai_composite": "China A"}
BUILD_NAME = {"sp500": "S&P 500", "nyse_composite": "NYSE Composite", "nasdaq_composite": "NASDAQ Composite", "sti": "Straits Times Index",
              "shanghai_composite": "Shanghai Composite", "shenzhen_component": "Shenzhen Component"}
FUNDS = [("es3_spdr_sti_etf", "SPDR STI ETF (ES3)"), ("a35_abf_sg_bond_etf", "ABF Singapore Bond ETF (A35)"),
         ("mbh_nikko_sgd_ig_bond_etf", "Nikko AM SGD IG Bond ETF (MBH)")]
BUILD_TICKER = {"sp500": "GSPC", "nyse_composite": "NYA", "nasdaq_composite": "IXIC", "sti": "STI", "shanghai_composite": "000001.SS",
                "shenzhen_component": "399001.SZ", "es3_spdr_sti_etf": "ES3.SI", "a35_abf_sg_bond_etf": "A35.SI", "mbh_nikko_sgd_ig_bond_etf": "MBH.SI"}
SHORT = {"Buy and hold": "Buy and hold", "10m SMA (~200 day)": "10-month average", "10m SMA with 3% band": "10-month average, 3% band",
         "12m momentum > 0": "12-month momentum", "Dual: SMA and momentum both negative": "Dual (average and momentum)",
         "3m/12m SMA cross (~golden cross)": "3/12-month cross", "Drawdown 15% out / 15% back in": "15% drawdown"}


def clean(x):
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (np.floating, float)):
        return None if not np.isfinite(x) else round(float(x), 6)
    if isinstance(x, np.integer):
        return int(x)
    return x


def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(clean(obj), f, separators=(",", ":"), allow_nan=False)


def pct(x, d=1):
    return f"{x * 100:+.{d}f}%"


def fmt(v):
    return f"{v:,.0f}" if v >= 1000 else f"{v:,.2f}"


def mon(d):
    return pd.Timestamp(d).strftime("%b %Y")


# ---------- 1. build.py, unchanged, on a temp folder laid out the way it expects ----------
tmp = tempfile.mkdtemp()
bd, bo = os.path.join(tmp, "in"), os.path.join(tmp, "out")
os.makedirs(bd); os.makedirs(bo)
for f, t in BUILD_TICKER.items():
    df = pd.read_csv(os.path.join(D, f + ".csv"))
    df.columns = ["Date", "Close"]
    df.to_csv(os.path.join(bd, t + ".csv"), index=False)
subprocess.run([sys.executable, os.path.join(HERE, "build.py"), bd, bo], check=True, stdout=subprocess.DEVNULL)
B = {n: json.load(open(os.path.join(bo, n + ".json")))["rows"] for n in ["phases", "current", "summary", "timing", "funds"]}
shutil.rmtree(tmp)

# ---------- 2. cash proxy: SGD deposit = 0.5 x US 3m T-bill, as in signals/out_sgd_cash ----------
tb = pd.read_csv(os.path.join(D, "us_tbill_3m_monthly.csv"), index_col=0, parse_dates=True)["rate"]
S.CASH = tb * 0.5

now_utc = dt.datetime.now(dt.timezone.utc)
markets, alerts, overview = [], [], []
corr_all = {}

for key, name, region, start, head, role in MARKETS:
    path = os.path.join(D, key + ".csv")
    res = S.run(key, path, start)                      # the project's own rules and backtests
    s = S.load(path)
    p_all = S.monthly(s)
    p = p_all[p_all.index >= start] if start else p_all
    last_day = s.index[-1]
    month_end = p.index[-1]
    partial = last_day.normalize() < month_end.normalize() - pd.Timedelta(days=3)  # month still running

    # positions for every rule (same functions signals.py backtests)
    pos = {k: fn(p).astype(int) for k, fn in S.RULES.items()}

    # flip levels for this month end: the close that would change each rule's signal
    prior = p.iloc[:-1]
    sma_lvl = prior.iloc[-9:].sum() / 9            # close > mean(last 10 incl. itself)  <=>  close > sum(prior 9)/9
    mom_lvl = p.iloc[-13] if len(p) > 13 else np.nan  # close > close 12 months earlier
    dual_lvl = min(sma_lvl, mom_lvl)
    flip = {"10m SMA (~200 day)": sma_lvl, "12m momentum > 0": mom_lvl, "Dual: SMA and momentum both negative": dual_lvl}
    last = float(s.iloc[-1])
    hl = res["rules"][head]
    hl_now = int(pos[head].iloc[-1])
    prev_sig = int(pos[head].iloc[-2])
    lvl = flip.get(head)
    gap = last / lvl - 1 if lvl else None

    # 20% phases from build.py (daily)
    bn = BUILD_NAME.get(key)
    cur = next((c for c in B["current"] if c["market"] == bn), None)
    summ = next((c for c in B["summary"] if c["market"] == bn), None)
    ph = [r for r in B["phases"] if r["market"] == bn]
    if cur is None:  # ES3 is not in build.py's equity list: fall back to signals.py's monthly phases
        turns = res["phases"]
        ph = []
        for a, b in zip(turns, turns[1:]):
            ph.append(dict(kind="Bear" if a["kind"] == "peak" else "Bull", start=a["date"], end=b["date"],
                           change_pct=round((b["level"] / a["level"] - 1) * 100, 1),
                           months=round((pd.Timestamp(b["date"]) - pd.Timestamp(a["date"])).days / 30.44, 1)))
        lt = turns[-1] if turns else None
        cur = dict(phase=res["provisional_phase"].capitalize(), since=lt["date"] if lt else res["from"],
                   change_since_turn_pct=round((last / lt["level"] - 1) * 100, 1) if lt else None,
                   extreme="High" if res["provisional_phase"] == "bull" else "Low",
                   extreme_date=res["provisional_extreme"]["date"],
                   from_extreme_pct=round((last / res["provisional_extreme"]["level"] - 1) * 100, 1),
                   to_bear_line_pct=round((res["provisional_extreme"]["level"] * 0.8 / last - 1) * 100, 1) if res["provisional_phase"] == "bull" else None)

    # corrections odds (corr.py)
    cs = C.stats(s)
    corr_all[key] = cs

    # chart series: monthly close, 10m SMA, headline position (full history for phases)
    sma10 = p_all.rolling(10).mean()
    hpos = pos[head].reindex(p_all.index)
    monthly = dict(t=[int(i.timestamp()) for i in p_all.index], c=[round(float(v), 4) for v in p_all.values],
                   sma=[None if np.isnan(v) else round(float(v), 4) for v in sma10.values],
                   pos=[None if np.isnan(v) else int(v) for v in hpos.values])
    d2 = s[s.index >= last_day - pd.Timedelta(days=730)]
    ma200 = s.rolling(200).mean().reindex(d2.index)
    daily = dict(t=[int(i.timestamp()) for i in d2.index], c=[round(float(v), 4) for v in d2.values],
                 ma=[None if np.isnan(v) else round(float(v), 4) for v in ma200.values])
    # growth of 1 under each rule vs hold (same math as signals.backtest)
    eq = {}
    r = p.pct_change().fillna(0)
    c0 = S.CASH.reindex(p.index).ffill().bfill().shift(1).fillna(0) / 1200
    for k in ["Buy and hold", head] + ([] if head == "10m SMA (~200 day)" else ["10m SMA (~200 day)"]):
        held = pos[k].shift(1).fillna(1)
        eq[SHORT[k]] = [round(float(v), 4) for v in (1 + held * r + (1 - held) * c0).cumprod().values]
    equity = dict(t=[int(i.timestamp()) for i in p.index], series=eq)

    # ---------- takeaways in plain English ----------
    nc = res["nowcast"]
    bh = res["rules"]["Buy and hold"]
    tk = []
    since = mon(cur["since"])
    if cur["phase"] == "Bull":
        tk.append(f"In a bull phase since {since}, {pct(cur['change_since_turn_pct'] / 100, 0)} off that low. "
                  f"It is {abs(cur['from_extreme_pct']):.1f}% below its {mon(cur['extreme_date'])} high; a 20% bear starts "
                  f"{abs(cur['to_bear_line_pct']):.1f}% lower.")
    else:
        tk.append(f"In a bear phase since {since}, {pct(cur['change_since_turn_pct'] / 100, 0)} from that peak. "
                  f"It is {cur['from_extreme_pct']:+.1f}% from its {mon(cur['extreme_date'])} low; a 20% bounce off the low ends it.")
    sig_word = "hold" if hl_now else "sell, stay in cash"
    if lvl and np.isfinite(lvl):
        side = "above" if last > lvl else "below"
        act = "sell to cash" if hl_now else "buy back in"
        tk.append(f"The {SHORT[head].lower()} rule says {sig_word} on the latest close ({fmt(last)}), {abs(gap) * 100:.1f}% {side} "
                  f"the {fmt(lvl)} line. It decides at the {month_end.strftime('%d %b')} close: below that line means {act}."
                  if hl_now else
                  f"The {SHORT[head].lower()} rule says {sig_word} on the latest close ({fmt(last)}), {abs(gap) * 100:.1f}% {side} "
                  f"the {fmt(lvl)} line. A {month_end.strftime('%d %b')} close above it means buy back in.")
    d10 = cs["stats"]["10%"]
    tk.append(f"Now {abs(cs['current_dd_from_1y_high']) * 100:.1f}% below its 1-year high. Since {res['from'][:4] if key != 'sp500' else '1928'}, "
              f"{d10['rate'] * 100:.0f}% of 10% dips went on to become 20% bears ({int(d10['became_bear'])} of {d10['episodes']}).")
    tk.append(f"Model odds: {nc['p_bull_now'] * 100:.0f}% that the bull phase is intact, {nc['p_up_12m'] * 100:.0f}% that it is higher in 12 months "
              f"(long-run base rate {nc['base_rate_up_12m'] * 100:.0f}%). The model scores no better than the base rate out of sample, so treat it as colour."
              if nc["walkforward_brier"] and nc["climatology_brier"] and nc["walkforward_brier"] >= nc["climatology_brier"] else
              f"Model odds: {nc['p_bull_now'] * 100:.0f}% that the bull phase is intact, {nc['p_up_12m'] * 100:.0f}% that it is higher in 12 months "
              f"(long-run base rate {nc['base_rate_up_12m'] * 100:.0f}%).")
    tk.append(f"Since {res['from'][:4]}, the {SHORT[head].lower()} rule returned {hl['cagr'] * 100:.1f}% a year with a worst fall of "
              f"{hl['maxdd'] * 100:.0f}%, against {bh['cagr'] * 100:.1f}% and {bh['maxdd'] * 100:.0f}% for buy and hold, "
              f"trading about {hl['trades_per_decade']:.0f} times a decade.")
    headline = (f"{'Hold' if hl_now else 'Sell'}: {abs(gap) * 100:.1f}% {'above' if last > lvl else 'below'} the line"
                if lvl and np.isfinite(lvl) else ("Hold" if hl_now else "Sell"))

    # ---------- alerts ----------
    lab = PLAN.get(key)
    sev_of = lambda g: "high" if g < 0.02 else "medium" if g < 0.05 else None
    if lab and lvl and np.isfinite(lvl):
        if hl_now != prev_sig:
            alerts.append(dict(level="high", market=name, title=f"{lab} rule {'says BUY BACK' if hl_now else 'says SELL'} on the latest close",
                               body=(f"Provisional until the {month_end.strftime('%d %b')} close. " if partial else "") +
                                    (f"If it holds at month end, sell {lab} holdings and keep SGD cash until it says buy again." if not hl_now else
                                     f"If it holds at month end, you can buy {lab} holdings again.")))
        sv = sev_of(abs(gap))
        if sv:
            alerts.append(dict(level=sv, market=name, title=f"{lab} rule is {abs(gap) * 100:.1f}% from a {'sell' if hl_now else 'buy'} signal",
                               body=f"{name} closed {fmt(last)}; the line for the {month_end.strftime('%d %b')} close is {fmt(lvl)}."))
    if cur["phase"] == "Bull" and cur.get("to_bear_line_pct") is not None and abs(cur["to_bear_line_pct"]) < 5:
        alerts.append(dict(level="medium", market=name, title=f"{name} is {abs(cur['to_bear_line_pct']):.1f}% from a 20% bear",
                           body=f"Down {abs(cur['from_extreme_pct']):.1f}% from the {mon(cur['extreme_date'])} high."))

    markets.append(dict(
        key=key, name=name, region=region, role=role, plan=lab, head_rule=head, head_short=SHORT[head],
        as_of=str(last_day.date()), month_end=str(month_end.date()), month_running=bool(partial), last=last,
        signal=hl_now, prev_signal=prev_sig, flip_level=lvl, flip_gap=gap, headline=headline,
        flips={SHORT[k]: v for k, v in flip.items()},
        phase=cur, phases=[dict(kind=r["kind"], start=r["start"], end=r["end"], change_pct=r["change_pct"], months=r["months"],
                                recovery_months=r.get("recovery_months")) for r in ph],
        summary=summ, takeaways=tk, nowcast=nc, corrections=cs,
        rules=[dict(name=SHORT[k], key=k, **{kk: v for kk, v in res["rules"][k].items() if kk not in ("last_change",)},
                    last_change=res["rules"][k]["last_change"], now=int(pos[k].iloc[-1])) for k in S.RULES],
        bears=[dict(b, rule=SHORT[head]) for b in res["bears"].get(head, [])],
        backtest_from=res["from"], monthly=monthly, daily=daily, equity=equity))
    overview.append(dict(key=key, name=name, region=region, plan=lab, signal=hl_now, head_short=SHORT[head], phase=cur["phase"],
                         from_high=cs["current_dd_from_1y_high"], gap=gap, last=last, as_of=str(last_day.date()),
                         spark=daily["c"][-130:], p_up=nc["p_up_12m"], headline=headline))

# ---------- funds (bond ETFs and ES3) ----------
funds = []
for key, name in FUNDS:
    s = S.load(os.path.join(D, key + ".csv"))
    f = next(x for x in B["funds"] if x["fund"] == name)
    w = s.resample("W").last().dropna()
    funds.append(dict(key=key, **f, t=[int(i.timestamp()) for i in w.index], c=[round(float(v), 4) for v in w.values]))

# ---------- watchlist: NVDA, SPCX, crypto names (levels and rules from the daily review) ----------
WCFG = json.load(open(os.path.join(HERE, "watchlist.json")))
wd = os.path.join(D, "watch")


def wl_state(x, btc_ok, cfg):
    """Flags for one ticker on the closes in x (rules as set in the daily review, 24 Nov 2026)."""
    n = 200 if len(x) >= 200 else 50
    trig = float(x.rolling(n).mean().iloc[-1])
    last = float(x.iloc[-1])
    m = x.resample("ME").last()
    m10 = m.rolling(10).mean()
    ten = None if np.isnan(m10.iloc[-1]) else float(m10.iloc[-1])
    above = last > trig
    up = cfg.get("analyst_upside_pct")
    if cfg["benchmark"]:
        status = "Above" if above else "Below"
    elif above and (btc_ok or not cfg["crypto"]):
        status = "Entry"
    elif cfg["stage_in"] and up is not None and up >= 25:
        status = "Stage in"
    else:
        status = "Wait"
    # exit: last completed month-end close fell below its 10-month average after being above it
    done = m.iloc[:-1] if x.index[-1] < m.index[-1] - pd.Timedelta(days=3) else m
    d10 = done.rolling(10).mean()
    exit_flag = bool(len(done) > 11 and done.iloc[-1] < d10.iloc[-1] and done.iloc[-2] > d10.iloc[-2])
    trim_flag = bool(last > trig * 1.4)
    exit_month = str(done.index[-1].date()) if exit_flag else None
    return dict(exit_month=exit_month, last=last, trigger=trig, trigger_basis=f"{n}-day average", pct_to_trigger=trig / last - 1,
                ten_month_avg=ten, status=status, exit_flag=exit_flag, trim_flag=trim_flag)


watch = []
btc = pd.read_csv(os.path.join(wd, "BTC-USD.csv"), index_col=0, parse_dates=True)["close"].dropna() if os.path.exists(os.path.join(wd, "BTC-USD.csv")) else None
btc_ok_now = bool(btc is not None and btc.iloc[-1] > btc.rolling(200).mean().iloc[-1])
btc_ok_prev = bool(btc is not None and btc.iloc[-2] > btc.rolling(200).mean().iloc[-2])
for cfg in WCFG["tickers"]:
    f = os.path.join(wd, cfg["ticker"] + ".csv")
    if not os.path.exists(f):
        continue
    x = pd.read_csv(f, index_col=0, parse_dates=True)["close"].dropna()
    st = wl_state(x, btc_ok_now, cfg)
    prev = wl_state(x.iloc[:-1], btc_ok_prev, cfg)
    n = 200 if len(x) >= 200 else 50
    y = x[x.index >= x.index[-1] - pd.Timedelta(days=380)]
    ma = x.rolling(n).mean().reindex(y.index)
    ago = x[x.index <= x.index[-1] - pd.Timedelta(days=30)]
    hi = float(x[x.index >= x.index[-1] - pd.Timedelta(days=365)].max())
    row = dict(cfg, **st, as_of=str(x.index[-1].date()), prev_status=prev["status"], chg30=float(x.iloc[-1] / ago.iloc[-1] - 1) if len(ago) else None,
               from_high=float(x.iloc[-1] / hi - 1), t=[int(i.timestamp()) for i in y.index], c=[round(float(v), 4) for v in y.values],
               ma=[None if np.isnan(v) else round(float(v), 4) for v in ma.values])
    watch.append(row)
    if cfg["benchmark"]:
        if btc_ok_now != btc_ok_prev:
            alerts.append(dict(level="high", market="Bitcoin", title=f"Bitcoin crossed {'above' if btc_ok_now else 'below'} its 200-day average",
                               body="Crypto names " + ("can now flag buys." if btc_ok_now else "go back to waiting.")))
        continue
    if st["status"] == "Entry" and prev["status"] != "Entry":
        alerts.append(dict(level="high", market=cfg["name"], title=f"{cfg['ticker']} is a buy",
                           body=f"Closed {fmt(st['last'])}, above its {st['trigger_basis']} of {fmt(st['trigger'])}."))
    if st["status"] != "Entry" and prev["status"] == "Entry":
        alerts.append(dict(level="medium", market=cfg["name"], title=f"{cfg['ticker']} is no longer a buy",
                           body=f"Closed {fmt(st['last'])}, below its {st['trigger_basis']} of {fmt(st['trigger'])}."))
    if st["exit_flag"] and not prev["exit_flag"]:
        alerts.append(dict(level="high", market=cfg["name"], title=f"{cfg['ticker']} sell signal",
                           body="Its month-end close fell below the 10-month average. Sell it if you hold it."))
    if st["trim_flag"] and not prev["trim_flag"]:
        alerts.append(dict(level="medium", market=cfg["name"], title=f"{cfg['ticker']} hit a take-profit level",
                           body="More than 40% above its average. If you hold it, consider selling part."))
alerts.sort(key=lambda a: {"high": 0, "medium": 1, "low": 2}[a["level"]])
dump("watchlist.json", dict(rules=WCFG["rules"], as_of_analyst=WCFG["as_of_analyst"], btc_ok=btc_ok_now, tickers=watch))
wsum = dict(entry=[w["ticker"] for w in watch if w["status"] == "Entry"], stage=[w["ticker"] for w in watch if w["status"] == "Stage in"],
            wait=len([w for w in watch if w["status"] == "Wait"]), exits=[w["ticker"] for w in watch if w["exit_flag"]],
            btc_ok=btc_ok_now, btc=next((dict(last=w["last"], trigger=w["trigger"], gap=w["pct_to_trigger"]) for w in watch if w["benchmark"]), None),
            closest=sorted([dict(ticker=w["ticker"], gap=w["pct_to_trigger"]) for w in watch if w["status"] == "Wait" and w["crypto"]], key=lambda z: z["gap"])[:3])

# ---------- calendar: next decision dates and review times ----------
sgt = dt.timezone(dt.timedelta(hours=8))
today_sgt = now_utc.astimezone(sgt).date()
me = (pd.Timestamp(today_sgt) + pd.offsets.MonthEnd(0)).date()
for m in markets:
    m.pop("prev_signal", None)
order = {"high": 0, "medium": 1, "low": 2}
alerts.sort(key=lambda a: order[a["level"]])

plan_cards = [dict(label=PLAN[m["key"]], market=m["name"], key=m["key"], rule=m["head_short"], signal=m["signal"],
                   last=m["last"], level=m["flip_level"], gap=m["flip_gap"], month_end=m["month_end"], as_of=m["as_of"])
              for m in markets if m["plan"]]

dump("overview.json", dict(generated=now_utc.isoformat(timespec="minutes"), as_of=max(m["as_of"] for m in markets),
                           next_decision=str(me), plan=plan_cards, alerts=alerts, markets=overview, watch=wsum,
                           summary=[x for x in B["summary"]], timing=B["timing"]))
for m in markets:
    dump(f"m_{m['key']}.json", m)
dump("funds.json", dict(funds=funds))
# research tickers: price series with 200-day average, for the research charts
stocks = {}
sd = os.path.join(D, "stocks")
if os.path.isdir(sd):
    for f in sorted(os.listdir(sd)):
        if f.endswith(".csv"):
            x = pd.read_csv(os.path.join(sd, f), index_col=0, parse_dates=True)["close"].dropna()
            ma = x.rolling(200).mean()
            y = x[x.index >= x.index[-1] - pd.Timedelta(days=380)]
            stocks[f[:-4]] = dict(as_of=str(y.index[-1].date()), last=float(y.iloc[-1]), ma200=float(ma.iloc[-1]),
                                  chg30=float(y.iloc[-1] / x[x.index <= x.index[-1] - pd.Timedelta(days=30)].iloc[-1] - 1),
                                  t=[int(i.timestamp()) for i in y.index], c=[round(float(v), 3) for v in y.values],
                                  ma=[None if np.isnan(v) else round(float(v), 3) for v in ma.reindex(y.index).values])
dump("stocks.json", stocks)
print("ok", len(markets), "markets", len(alerts), "alerts")
