"""Bull/bear phase labelling, long-horizon signal backtests and a current-phase nowcast.

Input: a CSV with columns date,close (daily or monthly). All rules run on month-end closes,
because the user holds for months to years. Cash earns 0 and prices exclude dividends,
so results are conservative for "out of market" periods and understate buy-and-hold income.
"""
import sys, json
import numpy as np
import pandas as pd

BEAR = 0.20  # classic 20% rule for phase labels


def load(path):
    df = pd.read_csv(path)
    df.columns = [c.lower() for c in df.columns]
    dcol = [c for c in df.columns if "date" in c][0]
    ccol = "close" if "close" in df.columns else [c for c in df.columns if c != dcol][0]
    s = pd.Series(df[ccol].values, index=pd.to_datetime(df[dcol]), dtype=float)
    s = s[s > 0].dropna().sort_index()
    return s


def monthly(s):
    return s.resample("ME").last().dropna()


def label_phases(p, thr=BEAR):
    """Ex-post labels: 1 = bull, 0 = bear. Bear runs from a peak to the trough of a
    >= thr decline; bull runs from a trough to the peak of a >= thr rise (alternating)."""
    v = p.values
    n = len(v)
    turns = []  # (index, 'peak'|'trough')
    state = "up"
    ext_i = 0
    for i in range(1, n):
        if state == "up":
            if v[i] > v[ext_i]:
                ext_i = i
            elif v[i] <= v[ext_i] * (1 - thr):
                turns.append((ext_i, "peak"))
                state, ext_i = "down", i
        else:
            if v[i] < v[ext_i]:
                ext_i = i
            elif v[i] >= v[ext_i] * (1 + thr):
                turns.append((ext_i, "trough"))
                state, ext_i = "up", i
    lab = np.ones(n, dtype=int)
    # before the first turn, infer from what came first
    cur = 1 if (not turns or turns[0][1] == "peak") else 0
    last = 0
    for idx, kind in turns:
        lab[last:idx + 1] = cur
        cur = 0 if kind == "peak" else 1
        last = idx + 1
    lab[last:] = cur  # last segment is provisional
    return pd.Series(lab, index=p.index), turns, state, ext_i


# ---------------- rules: each returns a 0/1 position decided at month end t, held over t+1
def r_buyhold(p):
    return pd.Series(1, index=p.index)


def r_sma(p, n=10, band=0.0):
    sma = p.rolling(n).mean()
    pos = pd.Series(np.nan, index=p.index)
    pos[p > sma * (1 + band)] = 1
    pos[p < sma * (1 - band)] = 0
    return pos.ffill().fillna(1)


def r_mom(p, n=12):
    return (p / p.shift(n) - 1 > 0).astype(int).where(p.shift(n).notna(), 1)


def r_dual(p):
    """Exit only when BOTH price < 10m SMA and 12m momentum < 0; re-enter when either recovers."""
    a, b = r_sma(p, 10), r_mom(p, 12)
    return ((a + b) > 0).astype(int)


def r_cross(p, f=3, s=12):
    return (p.rolling(f).mean() > p.rolling(s).mean()).astype(int).where(p.rolling(s).mean().notna(), 1)


def r_drawdown(p, out=0.15, back=0.15):
    """Exit after a fall of `out` from the running peak; re-enter after a rise of `back` off the low."""
    v = p.values
    pos = np.ones(len(v), dtype=int)
    inm, peak, low = True, v[0], v[0]
    for i, x in enumerate(v):
        if inm:
            peak = max(peak, x)
            if x <= peak * (1 - out):
                inm, low = False, x
        else:
            low = min(low, x)
            if x >= low * (1 + back):
                inm, peak = True, x
        pos[i] = int(inm)
    return pd.Series(pos, index=p.index)


RULES = {
    "Buy and hold": r_buyhold,
    "10m SMA (~200 day)": lambda p: r_sma(p, 10),
    "10m SMA with 3% band": lambda p: r_sma(p, 10, 0.03),
    "12m momentum > 0": lambda p: r_mom(p, 12),
    "Dual: SMA and momentum both negative": r_dual,
    "3m/12m SMA cross (~golden cross)": lambda p: r_cross(p, 3, 12),
    "Drawdown 15% out / 15% back in": lambda p: r_drawdown(p, .15, .15),
}


CASH = None  # monthly annualised cash rate in %, indexed by month end; None = cash earns 0


def backtest(p, pos, fwd=6):
    r = p.pct_change().fillna(0)
    held = pos.shift(1).fillna(1)
    c = 0 if CASH is None else (CASH.reindex(p.index).ffill().bfill().shift(1).fillna(0) / 1200)
    strat = held * r + (1 - held) * c
    eq = (1 + strat).cumprod()
    yrs = (p.index[-1] - p.index[0]).days / 365.25
    cagr = eq.iloc[-1] ** (1 / yrs) - 1
    vol = strat.std() * np.sqrt(12)
    mdd = (eq / eq.cummax() - 1).min()
    chg = pos.diff().fillna(0)
    exits = list(p.index[chg < 0])
    entries = list(p.index[chg > 0])

    def fwdret(d):
        i = p.index.get_loc(d)
        return p.iloc[i + fwd] / p.iloc[i] - 1 if i + fwd < len(p) else np.nan

    ex_f = [fwdret(d) for d in exits]
    en_f = [fwdret(d) for d in entries]
    false_exit = [x for x in ex_f if not np.isnan(x) and x > 0]
    false_entry = [x for x in en_f if not np.isnan(x) and x < 0]
    n_ex = sum(~np.isnan(ex_f)) if ex_f else 0
    n_en = sum(~np.isnan(en_f)) if en_f else 0
    return dict(
        cagr=cagr, vol=vol, sharpe0=(strat.mean() * 12) / vol if vol else np.nan, maxdd=mdd,
        time_in=held.mean(), exits=len(exits), trades_per_decade=len(exits) / yrs * 10,
        false_exit_rate=len(false_exit) / n_ex if n_ex else np.nan,
        false_entry_rate=len(false_entry) / n_en if n_en else np.nan,
        last_signal=int(pos.iloc[-1]),
        last_change=str((exits + entries) and max(exits + entries).date()),
    )


def bear_capture(p, pos, turns):
    """For each labelled bear (peak->trough): months from peak to exit, share of the fall avoided,
    and months from trough to re-entry, share of the first-year rebound missed."""
    out = []
    pk = [t for t in turns if t[1] == "peak"]
    tr = [t for t in turns if t[1] == "trough"]
    for (pi, _) in pk:
        ti = next((t for t, _ in tr if t > pi), None)
        if ti is None:
            continue
        P, T = p.iloc[pi], p.iloc[ti]
        seg = pos.iloc[pi:ti + 1]
        ex = seg[seg == 0]
        if len(ex):
            ei = p.index.get_loc(ex.index[0])
            lag_out = ei - pi
            avoided = (p.iloc[ei] - T) / (P - T)  # 1 = exited at the peak, 0 = exited at the trough
        else:
            lag_out, avoided = np.nan, 0.0
        after = pos.iloc[ti:]
        en = after[after == 1]
        lag_in = p.index.get_loc(en.index[0]) - ti if len(en) else np.nan
        out.append(dict(peak=str(p.index[pi].date()), trough=str(p.index[ti].date()),
                        fall=T / P - 1, months_to_exit=lag_out, fall_avoided=avoided,
                        months_to_reenter=lag_in))
    return out


# ---------------- nowcast
def features(p):
    sma10 = p.rolling(10).mean()
    f = pd.DataFrame({
        "dist_sma10": p / sma10 - 1,
        "mom12": p / p.shift(12) - 1,
        "mom3": p / p.shift(3) - 1,
        "dd": p / p.cummax() - 1,
        "sma_slope": sma10 / sma10.shift(3) - 1,
    })
    return f


def logit_fit(X, y, l2=1.0, it=500):
    X = np.c_[np.ones(len(X)), X]
    w = np.zeros(X.shape[1])
    for _ in range(it):  # Newton-Raphson with ridge
        z = X @ w
        pr = 1 / (1 + np.exp(-z))
        g = X.T @ (pr - y) + l2 * np.r_[0, w[1:]]
        H = (X * (pr * (1 - pr))[:, None]).T @ X + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        w -= np.linalg.solve(H, g)
    return w


def logit_pred(w, X):
    return 1 / (1 + np.exp(-(np.c_[np.ones(len(X)), X] @ w)))


def nowcast(p, lab, turns, horizon=12, drop_tail=12):
    """P(currently in a bull phase) and P(12m-forward price change > 0), from a ridge logistic
    model on trend features. The last `drop_tail` labels are provisional, so they are excluded
    from training. Also reports a simple empirical analogue rate."""
    f = features(p)
    fwd = (p.shift(-horizon) / p - 1 > 0).astype(float).where(p.shift(-horizon).notna())
    df = f.join(lab.rename("bull")).join(fwd.rename("up12")).dropna(subset=list(f.columns))
    mu, sd = df[f.columns].mean(), df[f.columns].std()
    Z = (df[f.columns] - mu) / sd
    tr = df.iloc[:-drop_tail]
    w_b = logit_fit(Z.loc[tr.index].values, tr["bull"].values)
    tr2 = df.dropna(subset=["up12"])
    w_u = logit_fit(Z.loc[tr2.index].values, tr2["up12"].values)
    zl = Z.iloc[[-1]].values
    pb = float(logit_pred(w_b, zl)[0])
    pu = float(logit_pred(w_u, zl)[0])
    # walk-forward check for the up12 model: train on data before each year, score that year
    briers, base = [], []
    years = sorted(set(tr2.index.year))
    for y in years[len(years) // 3:]:
        a = tr2[tr2.index.year < y - 1]  # gap of a year so the 12m target cannot leak
        b = tr2[tr2.index.year == y]
        if len(a) < 60 or not len(b):
            continue
        w = logit_fit(Z.loc[a.index].values, a["up12"].values)
        pr = logit_pred(w, Z.loc[b.index].values)
        briers += list((pr - b["up12"].values) ** 2)
        base += list((a["up12"].mean() - b["up12"].values) ** 2)
    # analogue: months with the same SMA side and a similar drawdown bucket
    cur = f.iloc[-1]
    side = np.sign(cur["dist_sma10"])
    ddb = pd.cut(df["dd"], [-1, -.3, -.2, -.1, -.05, 0.0001])
    curb = pd.cut(pd.Series([cur["dd"]]), [-1, -.3, -.2, -.1, -.05, 0.0001])[0]
    m = tr2[(np.sign(tr2["dist_sma10"]) == side) & (ddb.loc[tr2.index] == curb)]
    return dict(
        p_bull_now=pb, p_up_12m=pu, analogue_up_12m=float(m["up12"].mean()) if len(m) else None,
        analogue_n=int(len(m)), base_rate_up_12m=float(tr2["up12"].mean()),
        walkforward_brier=float(np.mean(briers)) if briers else None,
        climatology_brier=float(np.mean(base)) if base else None,
        current=dict((k, float(v)) for k, v in cur.items()),
        coefs_bull=dict(zip(["const"] + list(f.columns), map(float, w_b))),
    )


def run(name, path, start=None):
    s = load(path)
    p = monthly(s)
    if start:
        p = p[p.index >= start]
    lab, turns, state, ext_i = label_phases(p)
    res = {"market": name, "from": str(p.index[0].date()), "to": str(p.index[-1].date()),
           "last_close": float(p.iloc[-1]), "rules": {}, "bears": {}}
    for k, fn in RULES.items():
        pos = fn(p).astype(int)
        res["rules"][k] = backtest(p, pos)
        if k != "Buy and hold":
            res["bears"][k] = bear_capture(p, pos, turns)
    res["phases"] = [dict(date=str(p.index[i].date()), kind=k, level=float(p.iloc[i])) for i, k in turns]
    res["provisional_phase"] = "bull" if state == "up" else "bear"
    res["provisional_extreme"] = dict(date=str(p.index[ext_i].date()), level=float(p.iloc[ext_i]))
    res["drawdown_now"] = float(p.iloc[-1] / p.cummax().iloc[-1] - 1)
    res["nowcast"] = nowcast(p, lab, turns)
    # sub-period robustness for the main rules
    sub = {}
    mid = p.index[len(p) // 2]
    for a, b in [(p.index[0], mid), (mid, p.index[-1])]:
        q = p[(p.index >= a) & (p.index <= b)]
        sub[f"{a.year}-{b.year}"] = {k: backtest(q, RULES[k](q).astype(int))
                                                        for k in RULES}
    res["subperiods"] = sub
    return res


if __name__ == "__main__":
    name, path = sys.argv[1], sys.argv[2]
    start = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
    if len(sys.argv) > 4:  # cash spec: "tbill", "tbill-1" (T-bill minus 1 pt, floor 0) or a flat number
        tb = pd.read_csv("data/tbill_monthly.csv", index_col=0, parse_dates=True)["rate"]
        spec = sys.argv[4]
        CASH = tb if spec == "tbill" else tb * 0.5 if spec == "sgd" else (tb - 1).clip(lower=0) if spec == "tbill-1" else pd.Series(float(spec), index=tb.index)
    out = run(name, path, start)
    print(json.dumps(out, indent=1, default=str))
