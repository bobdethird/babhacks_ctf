"""Auto_9: improved version of the Auto_8 TQQQ timing strategy.

Two changes vs Auto_8 (everything else canonical):
  1. defensive_frac: 1/3 -> 1/2   (bear-regime T2 allocation)
  2. risk-on leverage 1.3         (when the canonical risk-on override fires,
                                   target 130% TQQQ instead of 100%; the
                                   borrow is charged fed funds + spread)

An optional global scale produces the conservative variant:
  Auto_9C = 0.8 * Auto_9 targets (max DD -39.9% vs -47.2%).

Usage:
  python3 auto9.py                 # Auto_9 (scale 1.0)
  python3 auto9.py --scale 0.8     # Auto_9C conservative
  python3 auto9.py --replicate     # exact Auto_8 replication check
"""
import argparse
import numpy as np
import pandas as pd

CONFIGS = [
    (14, 0.020, 300, 42), (18, 0.020, 300, 42), (21, 0.020, 175, 126),
    (14, 0.022, 300, 42), (14, 0.015, 80, 42), (14, 0.015, 80, 63),
    (21, 0.020, 300, 42), (18, 0.020, 225, 126), (21, 0.020, 150, 126),
    (18, 0.020, 175, 126),
]


def load_data(path='data/daily_log.csv'):
    df = pd.read_csv(path, parse_dates=['date']).set_index('date')
    # recover fed funds from cash accrual on HOLD days
    cash_prev = df.cash_value.shift(1)
    days = df.index.to_series().diff().dt.days
    m = (df.action == 'HOLD') & (cash_prev > 1000)
    ff = ((df.cash_value / cash_prev) ** (365.0 / days) - 1).where(m)
    df['fedfunds'] = ff.ffill().bfill()
    return df


def target_allocation(df, def_frac=0.5, riskon_lev=1.3, scale=1.0):
    """Daily target TQQQ allocation. def_frac=1/3, riskon_lev=1.0 == Auto_8."""
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    rv252 = r.rolling(252).std(ddof=0) * np.sqrt(252)

    def gate(cond, valid):
        # insufficient history => gate passes (matches Auto_8 logs exactly)
        g = cond.astype(float)
        g[~valid] = 1.0
        return g

    def ma_gate(m):
        ma = P.rolling(m).mean()
        return gate(P > ma, ma.notna())

    def mom_gate(k):
        pk = P.shift(k)
        return gate(P > pk, pk.notna())

    t1 = []
    for (w, th, m, k) in CONFIGS:
        sd = r.rolling(w).std(ddof=0)
        t1.append(gate(sd < th, sd.notna()) * ma_gate(m) * mom_gate(k))

    b = ((rv252 - 0.28) / 0.10).clip(0, 1).fillna(0.0)
    u = 1 - b
    t2_bull = ma_gate(40) * mom_gate(15)
    t2_bear = ma_gate(300) * mom_gate(252)

    s = 0.0
    for t1j in t1:
        a_bull = np.maximum(t1j, t2_bull)
        a_bear = np.maximum(t1j, def_frac * t2_bear * (t1j == 0))
        s = s + u * a_bull + b * a_bear
    a_base = s / 10

    vxn_gate = (df.vxn <= 0.40).astype(float)
    vxn_gate[df.vxn.isna()] = 0.0
    low_rv = gate(rv252 <= 0.16, rv252.notna())
    risk_on = vxn_gate * low_rv * ma_gate(300) * mom_gate(126)

    a = scale * np.maximum(a_base, riskon_lev * risk_on)

    a_q = (a / 0.10).round() * 0.10
    R = P / P.shift(1) - 1
    cb = (R.shift(1) <= -0.0475).fillna(False).astype(bool)
    return a_q.where(~cb, 0.0)


def run_portfolio(df, A, band=0.05, borrow_spread=0.015, start=1_000_000.0):
    Q = df.tqqq_close.values
    ff = df.fedfunds.values
    ddays = df.index.to_series().diff().dt.days.values
    n = len(df)
    equity = np.empty(n)
    cash, shares, last = start, 0.0, None
    Av = np.asarray(A, float)
    actions = []
    n_trades = 0
    for t in range(n):
        if t > 0:
            rate = ff[t - 1] + (borrow_spread if cash < 0 else 0.0)
            cash *= (1 + rate) ** (ddays[t] / 365.0)
        eq = shares * Q[t] + cash
        a = Av[t]
        if last is None or abs(a - last) >= band:
            shares = a * eq / Q[t]
            cash = eq - a * eq
            last = a
            n_trades += 1
            actions.append('TRADE')
        else:
            actions.append('HOLD')
        equity[t] = shares * Q[t] + cash
    return pd.Series(equity, index=df.index), actions, n_trades


def metrics(eq, name=''):
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1
    dd = (eq / eq.cummax() - 1).min()
    ret = eq.pct_change().dropna()
    return dict(name=name, cagr=round(cagr * 100, 4), maxdd=round(dd * 100, 4),
                calmar=round(cagr / abs(dd), 4),
                sharpe=round(ret.mean() / ret.std() * np.sqrt(252), 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--replicate', action='store_true',
                    help='run canonical Auto_8 and check vs provided logs')
    ap.add_argument('--data', default='data/daily_log.csv')
    args = ap.parse_args()

    df = load_data(args.data)
    if args.replicate:
        A = target_allocation(df, def_frac=1 / 3, riskon_lev=1.0)
        mismatch = (A - df.target_alloc_tqqq).abs() > 1e-9
        print(f'Auto_8 replication: {mismatch.sum()} target mismatches '
              f'on {len(df)} days')
        eq, _, ntr = run_portfolio(df, A, borrow_spread=0.0)
        print(metrics(eq, 'Auto_8 replicated'), 'trades:', ntr)
        return

    A = target_allocation(df, scale=args.scale)
    eq, actions, ntr = run_portfolio(df, A)
    name = f'Auto_9 (scale={args.scale})'
    print(metrics(eq, name), 'trades/yr:',
          round(ntr / ((df.index[-1] - df.index[0]).days / 365.25), 1))
    out = pd.DataFrame({'target_alloc': A, 'action': actions, 'equity': eq})
    fn = f'data/auto9_daily_log_scale{args.scale}.csv'
    out.to_csv(fn)
    print('wrote', fn)


if __name__ == '__main__':
    main()
