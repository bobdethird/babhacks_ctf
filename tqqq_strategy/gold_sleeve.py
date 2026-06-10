"""Gold defensive sleeve (G1): TQQQ + gold + cash, three-asset accounting.

The TQQQ allocation A(t) is untouched (Auto_8/Auto_9 pipeline). The cash
leg (1-A) is split: a fraction goes to gold when gold passes BOTH
  - absolute momentum: gold total return over `lb` days exceeds the
    cash total return (fed funds) over the same window, and
  - trend: gold > its `ma`-day moving average.
Gold sleeve weight: G(t) = g_frac * (1 - A(t)) * gate(t).
Bands: trade TQQQ on |dA| >= 0.05 (canonical), gold sleeve on |dG| >= 0.05.
After the last valid gold date the gate is forced off (data tail honesty).
"""
import numpy as np
import pandas as pd
from research_v2 import load_data, metrics, IS_END, OOS_START


def load_gold(df, path='data/external/lbma_gold_daily.csv'):
    gold = pd.read_csv(path, parse_dates=['date']).set_index('date')['gold_pm_usd']
    gold = gold.replace(0, np.nan).dropna()
    return gold.reindex(df.index.union(gold.index)).ffill(limit=5).reindex(df.index)


def gold_gate(df, g, lb=252, ma=200):
    ff = df.fedfunds
    cash_idx = (1 + ff.shift(1) / 252).cumprod()
    gold_mom = g / g.shift(lb)
    cash_mom = cash_idx / cash_idx.shift(lb)
    gate = ((gold_mom > cash_mom) & (g > g.rolling(ma).mean())).astype(float)
    gate[g.isna() | gold_mom.isna()] = 0.0
    # force off after last real gold quote
    last = g.last_valid_index()
    gate.loc[gate.index > last] = 0.0
    return gate


def run_three_asset(df, A, G, band=0.05, tc=0.0, borrow_spread=0.015,
                    start=1_000_000.0):
    Q = df.tqqq_close.values
    gv = load_gold.__defaults__ and None  # placeholder, gold passed via G price
    ff = df.fedfunds.values
    ddays = df.index.to_series().diff().dt.days.values
    gold_px = G['price'].values
    Gw = np.nan_to_num(np.asarray(G['weight'], float), nan=0.0)
    Av = np.nan_to_num(np.asarray(A, float), nan=0.0)
    n = len(df)
    equity = np.empty(n)
    cash, sh_t, sh_g = start, 0.0, 0.0
    last_a, last_g = None, None
    n_trades = 0
    for t in range(n):
        if t > 0:
            rate = ff[t - 1] + (borrow_spread if cash < 0 else 0.0)
            cash *= (1 + rate) ** (ddays[t] / 365.0)
        gp = gold_px[t] if np.isfinite(gold_px[t]) else (gold_px[t - 1] if t else 0)
        eq = sh_t * Q[t] + sh_g * gp + cash
        a, gw = Av[t], Gw[t]
        trade_a = last_a is None or abs(a - last_a) >= band
        trade_g = last_g is None or abs(gw - last_g) >= band
        if trade_a or trade_g:
            ta = a if trade_a else last_a
            tg = gw if trade_g else last_g
            traded = abs(ta * eq - sh_t * Q[t]) + abs(tg * eq - sh_g * gp)
            cash = eq - ta * eq - tg * eq - tc * traded
            sh_t = ta * eq / Q[t]
            sh_g = tg * eq / gp if gp > 0 else 0.0
            last_a, last_g = ta, tg
            n_trades += 1
        equity[t] = sh_t * Q[t] + sh_g * gp + cash
    return pd.Series(equity, index=df.index), n_trades
