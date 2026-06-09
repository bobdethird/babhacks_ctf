"""Research framework v2: structurally new decision methods vs Auto_8.

Anti-overfit protocol:
  - IS (train): 1985-02-04 .. 2009-12-31  — all development happens here
  - OOS (test): 2010-01-01 .. 2026-04-28  — evaluated once for frozen finalists
  - identical execution mechanics for every strategy (close execution,
    same cash accounting, optional transaction costs)
  - plateau-based parameter selection on IS

Execution convention (matches Auto_8 logs exactly, verified):
  signal computed from closes up to day t -> position executed at close t
  -> earns TQQQ return from close t to close t+1.
"""
import numpy as np
import pandas as pd

IS_END = '2009-12-31'
OOS_START = '2010-01-01'


def load_data(path='data/daily_log.csv'):
    df = pd.read_csv(path, parse_dates=['date']).set_index('date')
    cash_prev = df.cash_value.shift(1)
    days = df.index.to_series().diff().dt.days
    m = (df.action == 'HOLD') & (cash_prev > 1000)
    ff = ((df.cash_value / cash_prev) ** (365.0 / days) - 1).where(m)
    df['fedfunds'] = ff.ffill().bfill()
    return df


def run_portfolio(df, A, band=0.05, tc=0.0, start=1_000_000.0,
                  borrow_spread=0.015):
    """tc = one-way transaction cost as a fraction of traded notional."""
    Q = df.tqqq_close.values
    ff = df.fedfunds.values
    ddays = df.index.to_series().diff().dt.days.values
    n = len(df)
    equity = np.empty(n)
    cash, shares, last = start, 0.0, None
    Av = np.nan_to_num(np.asarray(A, float), nan=0.0)
    n_trades = 0
    for t in range(n):
        if t > 0:
            rate = ff[t - 1] + (borrow_spread if cash < 0 else 0.0)
            cash *= (1 + rate) ** (ddays[t] / 365.0)
        eq = shares * Q[t] + cash
        a = Av[t]
        if last is None or abs(a - last) >= band:
            traded = abs(a * eq - shares * Q[t])
            cash = eq - a * eq - tc * traded
            shares = a * eq / Q[t]
            last = a
            n_trades += 1
        equity[t] = shares * Q[t] + cash
    return pd.Series(equity, index=df.index), n_trades


def metrics(eq, name='', n_trades=None):
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1
    dd = (eq / eq.cummax() - 1).min()
    ret = eq.pct_change().dropna()
    out = dict(name=name, cagr=round(cagr * 100, 2), maxdd=round(dd * 100, 2),
               calmar=round(cagr / abs(dd), 3),
               sharpe=round(ret.mean() / ret.std() * np.sqrt(252), 3))
    if n_trades is not None:
        out['tpy'] = round(n_trades / yrs, 1)
    return out


def finalize(A, P, quant=0.10, cb=-0.0475):
    """Shared post-processing: quantize + 1-day circuit breaker (same as Auto_8)."""
    a_q = (A / quant).round() * quant
    R = P / P.shift(1) - 1
    hit = (R.shift(1) <= cb).fillna(False).astype(bool)
    return a_q.where(~hit, 0.0)


# ---------------- hypothesis strategies ----------------

def h1_kelly(df, mu_spans=(21, 63, 126), var_span=33, c=1.0, amax=1.0):
    """Fractional Kelly: A = clip(c * mu_hat / (3 * var_hat), 0, amax).

    mu_hat: average of EWM mean daily log returns over several horizons
            (annualized). var_hat: EWMA variance (annualized). The factor 3
    converts desired index leverage into TQQQ allocation.
    """
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    mus = [r.ewm(span=s).mean() * 252 for s in mu_spans]
    mu = sum(mus) / len(mus)
    var = (r.ewm(span=var_span).mean() * 0 + r).ewm(span=var_span).var() * 252
    lev = (c * mu / var).clip(0, 3 * amax)
    A = lev / 3.0
    # no signal until 1y of history (conservative warmup, no free pass)
    A[r.rolling(252).count() < 252] = 0.0
    return A


def h2_voltrend(df, ma=200, sigma_star=0.20, k=2.0, vol_span=33, amax=1.0):
    """Vol-managed trend: A = 1{P>MA} * min(1, (sigma*/sigma_hat)^k)."""
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    sd = np.sqrt(r.ewm(span=vol_span).var() * 252)
    trend = (P > P.rolling(ma).mean()).astype(float)
    A = trend * ((sigma_star / sd) ** k).clip(0, 1) * amax
    A[P.rolling(ma).count() < ma] = 0.0
    return A


def h3_cta(df, horizons=(10, 21, 42, 63, 126, 252), vol_span=33,
           sigma_star=0.20, k=1.0):
    """CTA-style: trend breadth across horizons, scaled by vol ratio."""
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    sigs = [(P > P.shift(h)).astype(float) for h in horizons]
    breadth = sum(sigs) / len(sigs)
    sd = np.sqrt(r.ewm(span=vol_span).var() * 252)
    A = breadth * ((sigma_star / sd) ** k).clip(0, 1)
    A[P.rolling(max(horizons)).count() < max(horizons)] = 0.0
    return A
