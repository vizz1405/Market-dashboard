# Builds the Bull and Bear Atlas datasets from Yahoo Finance daily closes (adjusted).
# Usage: python3 build.py <data_dir> <out_dir>
import pandas as pd, numpy as np, json, sys, os
D, OUT = sys.argv[1], sys.argv[2]
CODE = open(os.path.abspath(__file__)).read()
EQ = {"GSPC":"S&P 500","NYA":"NYSE Composite","IXIC":"NASDAQ Composite","STI":"Straits Times Index","000001.SS":"Shanghai Composite","399001.SZ":"Shenzhen Component"}
FUNDS = {"ES3.SI":"SPDR STI ETF (ES3)","A35.SI":"ABF Singapore Bond ETF (A35)","MBH.SI":"Nikko AM SGD IG Bond ETF (MBH)"}
TH = 0.20  # bull/bear threshold: a 20% move from the last peak or trough

def load(t):
    s = pd.read_csv(f"{D}/{t}.csv", index_col=0)["Close"].astype(float)
    s.index = pd.to_datetime(s.index); s = s[s > 0].dropna()
    return s[~s.index.duplicated()]

def turns(s):
    """Alternating peaks and troughs. A peak is confirmed once price falls 20% below it,
    a trough once price rises 20% above it."""
    pts = []; mode = None; hi_i = lo_i = s.index[0]; hi = lo = s.iloc[0]; ext = ext_i = None
    for i, v in s.items():
        if mode is None:
            if v > hi: hi, hi_i = v, i
            if v < lo: lo, lo_i = v, i
            if v <= hi * (1 - TH): pts.append(("peak", hi_i, hi)); mode = "bear"; ext, ext_i = v, i
            elif v >= lo * (1 + TH): pts.append(("trough", lo_i, lo)); mode = "bull"; ext, ext_i = v, i
        elif mode == "bull":
            if v > ext: ext, ext_i = v, i
            elif v <= ext * (1 - TH): pts.append(("peak", ext_i, ext)); mode = "bear"; ext, ext_i = v, i
        else:
            if v < ext: ext, ext_i = v, i
            elif v >= ext * (1 + TH): pts.append(("trough", ext_i, ext)); mode = "bull"; ext, ext_i = v, i
    return pts, mode, ext_i, ext

ds = lambda x: str(x.date())
r1 = lambda x: None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 1)
def ago(s, days):
    p = s[s.index <= s.index[-1] - pd.Timedelta(days=days)]
    return p.iloc[-1] if len(p) else np.nan

phases, current, summary, timing, prices, funds = [], [], [], [], [], []
for t, n in EQ.items():
    s = load(t); pts, mode, ei, ev = turns(s); ma = s.rolling(200).mean()
    rows = []
    for a, b in zip(pts, pts[1:]):
        kind = "Bear" if a[0] == "peak" else "Bull"
        r = dict(market=n, kind=kind, start=ds(a[1]), end=ds(b[1]), change_pct=r1((b[2]/a[2]-1)*100),
                 months=r1((b[1]-a[1]).days/30.44), runup_12m_pct=None, recovery_months=None, ma200_signal_pct=None)
        if kind == "Bear":
            y = s[s.index <= a[1] - pd.Timedelta(days=365)]
            r["runup_12m_pct"] = r1((a[2]/y.iloc[-1]-1)*100) if len(y) else None
            after = s[b[1]:]; rec = after[after >= a[2]]
            r["recovery_months"] = r1((rec.index[0]-a[1]).days/30.44) if len(rec) else None
            seg = s[a[1]:b[1]]; below = seg[seg < ma[a[1]:b[1]]]
            r["ma200_signal_pct"] = r1((below.iloc[0]/a[2]-1)*100) if len(below) else None  # loss from peak when price first closed under its 200-day average
        else:
            seg = s[a[1]:b[1]]; above = seg[seg > ma[a[1]:b[1]]]
            r["ma200_signal_pct"] = r1((above.iloc[0]/a[2]-1)*100) if len(above) else None  # gain from trough when price first closed over its 200-day average
        rows.append(r)
    phases += rows
    last = pts[-1]
    current.append(dict(market=n, phase=mode.capitalize(), since=ds(last[1]),
        change_since_turn_pct=r1((s.iloc[-1]/last[2]-1)*100),
        extreme=("High" if mode == "bull" else "Low"), extreme_date=ds(ei),
        from_extreme_pct=r1((s.iloc[-1]/ev-1)*100),
        to_bear_line_pct=r1(((ev*(1-TH))/s.iloc[-1]-1)*100) if mode == "bull" else None,
        vs_200d_pct=r1((s.iloc[-1]/ma.iloc[-1]-1)*100), change_1m_pct=r1((s.iloc[-1]/ago(s,30)-1)*100),
        last_close=round(float(s.iloc[-1]), 2), as_of=ds(s.index[-1]), history_from=ds(s.index[0])))
    # base rate: falls of 10%+ from a record high, and how many reached 20%+
    dd = s/s.cummax()-1; eps = []; inside = False
    for i, v in dd.items():
        if not inside and v <= -0.10: inside = True; st = i
        if inside and v == 0: eps.append(dd[st:i].min()); inside = False
    big = [e for e in eps if e <= -TH]
    bulls = [x for x in rows if x["kind"] == "Bull"]; bears = [x for x in rows if x["kind"] == "Bear"]
    summary.append(dict(market=n, history_from=ds(s.index[0]), bulls=len(bulls), bears=len(bears),
        bull_median_months=r1(np.median([x["months"] for x in bulls])), bull_median_gain_pct=r1(np.median([x["change_pct"] for x in bulls])),
        bear_median_months=r1(np.median([x["months"] for x in bears])), bear_median_loss_pct=r1(np.median([x["change_pct"] for x in bears])),
        worst_bear_pct=r1(min(x["change_pct"] for x in bears)), longest_bull_months=r1(max(x["months"] for x in bulls)),
        time_in_bull_pct=r1(sum(x["months"] for x in bulls)/sum(x["months"] for x in rows)*100),
        dips_10=len(eps), dips_became_bear=len(big), dip_to_bear_pct=r1(len(big)/len(eps)*100) if eps else None,
        median_bear_depth_from_high_pct=r1(np.median(big)*100) if big else None))
    # 10-month average rule: hold when last month-end close is above its 10-month average, else cash at 0%
    m = s.resample("ME").last(); sig = (m > m.rolling(10).mean()).shift(1)
    ret = m.pct_change(); bh = ret.iloc[11:]; st_r = ret.where(sig == True, 0).iloc[11:]; yrs = len(bh)/12
    cagr = lambda x: r1(((1+x.fillna(0)).prod()**(1/yrs)-1)*100)
    def mdd(x): w = (1+x.fillna(0)).cumprod(); return r1((w/w.cummax()-1).min()*100)
    timing.append(dict(market=n, years=r1(yrs), hold_cagr_pct=cagr(bh), rule_cagr_pct=cagr(st_r),
        hold_worst_drop_pct=mdd(bh), rule_worst_drop_pct=mdd(st_r),
        trades=int((sig.iloc[11:].astype(float).diff().abs() > 0).sum()), invested_pct=r1(sig.iloc[11:].mean()*100),
        signal_now=("Invested" if m.iloc[-1] > m.rolling(10).mean().iloc[-1] else "In cash")))
    w = s.resample("W").last().dropna() if s.index[0].year >= 1960 else pd.concat([s[:"1959"].resample("ME").last(), s["1960":].resample("W").last()]).dropna()
    prices += [dict(market=n, date=ds(i), close=round(float(v), 2)) for i, v in w.items()]
for t, n in FUNDS.items():
    s = load(t); dd = s/s.cummax()-1; yrs = (s.index[-1]-s.index[0]).days/365.25
    wi = dd.idxmin(); pk = s[:wi].idxmax(); rec = s[wi:][s[wi:] >= s[pk]]
    funds.append(dict(fund=n, kind=("Bond" if "Bond" in n else "Equity"), history_from=ds(s.index[0]),
        yearly_return_pct=r1(((s.iloc[-1]/s.iloc[0])**(1/yrs)-1)*100), worst_drop_pct=r1(dd.min()*100),
        worst_drop_from=ds(pk), worst_drop_to=ds(wi), recovered_on=(ds(rec.index[0]) if len(rec) else "Not yet"),
        now_below_high_pct=r1(dd.iloc[-1]*100), change_1m_pct=r1((s.iloc[-1]/ago(s,30)-1)*100), as_of=ds(s.index[-1])))
    prices += [dict(market=n, date=ds(i), close=round(float(v), 4)) for i, v in s.resample("W").last().dropna().items()]

meta = [dict(label="build.py", value=CODE, type="code", lang="python"),
        dict(label="Input", value="Yahoo Finance daily closes, adjusted, downloaded 2026-11-21: ^GSPC ^NYA ^IXIC ^STI 000001.SS 399001.SZ ES3.SI A35.SI MBH.SI")]
for name, rows in [("phases", phases), ("current", current), ("summary", summary), ("timing", timing), ("prices", prices), ("funds", funds)]:
    json.dump(dict(rows=rows, meta=meta), open(f"{OUT}/{name}.json", "w"), allow_nan=False)
    print(name, len(rows), os.path.getsize(f"{OUT}/{name}.json"))
