"""Auto_8 replication + variant backtest engine for TQQQ timing strategies.

Data: daily_log.csv provides XNDX close, synthetic TQQQ close, VXN, and
implied fed-funds (recovered from cash accrual on HOLD days).
"""
import numpy as np
import pandas as pd

CONFIGS = [
    (14, 0.020, 300, 42),
    (18, 0.020, 300, 42),
    (21, 0.020, 175, 126),
    (14, 0.022, 300, 42),
    (14, 0.015, 80, 42),
    (14, 0.015, 80, 63),
    (21, 0.020, 300, 42),
    (18, 0.020, 225, 126),
    (21, 0.020, 150, 126),
    (18, 0.020, 175, 126),
]


def load_data(path='data/daily_log.csv'):
    df = pd.read_csv(path, parse_dates=['date']).set_index('date')
    # implied fed funds from cash accrual on HOLD days with cash held
    cash_prev = df.cash_value.shift(1)
    days = df.index.to_series().diff().dt.days
    m = (df.action == 'HOLD') & (cash_prev > 1000)
    ff = ((df.cash_value / cash_prev) ** (365.0 / days) - 1).where(m)
    df['fedfunds'] = ff.ffill().bfill()
    return df


def compute_signals(df, ddof=1):
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    out = pd.DataFrame(index=df.index)
    out['rv252'] = r.rolling(252).std(ddof=ddof) * np.sqrt(252)
    out['r'] = r
    return out


def auto8_alloc(df, sig,
                bull_ma=40, bull_mom=15,
                bear_ma=300, bear_mom=252, def_frac=1/3,
                blend_lo=0.28, blend_hi=0.38,
                risk_vxn=0.40, risk_rv=0.16, risk_ma=300, risk_mom=126,
                cb=-0.0475, quant=0.10, ddof=1,
                nan_gate=False):
    """Compute the daily target allocation series A(t) for Auto_8.

    nan_gate: value a gate takes when there is insufficient history.
    """
    P = df.xndx_close
    r = sig['r']
    rv252 = sig['rv252']

    def gate(cond, valid):
        g = cond.astype(float)
        g[~valid] = float(nan_gate)
        return g

    def ma_gate(m):
        ma = P.rolling(m).mean()
        return gate(P > ma, ma.notna())

    def mom_gate(k):
        pk = P.shift(k)
        return gate(P > pk, pk.notna())

    t1 = []
    for (w, th, m, k) in CONFIGS:
        sd = r.rolling(w).std(ddof=ddof)
        rvg = gate(sd < th, sd.notna())
        t1.append(rvg * ma_gate(m) * mom_gate(k))

    b = ((rv252 - blend_lo) / (blend_hi - blend_lo)).clip(0, 1)
    b = b.fillna(0.0)
    u = 1 - b

    t2_bull = ma_gate(bull_ma) * mom_gate(bull_mom)
    t2_bear = ma_gate(bear_ma) * mom_gate(bear_mom)

    a_sum = 0.0
    for t1j in t1:
        a_bull = np.maximum(t1j, t2_bull)
        a_bear = np.maximum(t1j, def_frac * t2_bear * (t1j == 0))
        a_sum = a_sum + (u * a_bull + b * a_bear)
    a_base = a_sum / len(t1)

    vxn_gate = (df.vxn <= risk_vxn).astype(float)
    vxn_gate[df.vxn.isna()] = 0.0
    low_rv = gate(rv252 <= risk_rv, rv252.notna())
    risk_on = vxn_gate * low_rv * ma_gate(risk_ma) * mom_gate(risk_mom)

    a_risk = np.maximum(a_base, risk_on)
    a_q = (a_risk / quant).round() * quant

    R = P / P.shift(1) - 1
    cb_hit = (R.shift(1) <= cb).fillna(False)
    A = a_q.where(~cb_hit, 0.0)
    return A, a_base, risk_on, cb_hit


def run_portfolio(df, A, rebal_band=0.05, start_equity=1_000_000.0):
    """Simulate the portfolio given daily target allocation A."""
    Q = df.tqqq_close.values
    ff = df.fedfunds.values
    dts = df.index
    ddays = dts.to_series().diff().dt.days.values

    n = len(df)
    equity = np.empty(n)
    alloc_exec = np.empty(n)
    cash = start_equity
    shares = 0.0
    last_trade_alloc = None
    Av = np.asarray(A, dtype=float)
    n_trades = 0
    for t in range(n):
        if t > 0:
            cash *= (1 + ff[t - 1]) ** (ddays[t] / 365.0)
        eq = shares * Q[t] + cash
        a = Av[t]
        if last_trade_alloc is None or abs(a - last_trade_alloc) >= rebal_band:
            target = a * eq
            shares = target / Q[t]
            cash = eq - target
            last_trade_alloc = a
            n_trades += 1
        equity[t] = shares * Q[t] + cash
        alloc_exec[t] = shares * Q[t] / equity[t] if equity[t] > 0 else 0.0
    return pd.Series(equity, index=dts), n_trades


def metrics(equity, dts=None, name=''):
    e = equity.values if isinstance(equity, pd.Series) else equity
    idx = equity.index if isinstance(equity, pd.Series) else dts
    yrs = (idx[-1] - idx[0]).days / 365.25
    cagr = (e[-1] / e[0]) ** (1 / yrs) - 1
    peak = np.maximum.accumulate(e)
    dd = (e / peak - 1).min()
    ret = pd.Series(e, index=idx).pct_change().dropna()
    sharpe = ret.mean() / ret.std() * np.sqrt(252)
    calmar = cagr / abs(dd)
    return dict(name=name, cagr=cagr * 100, maxdd=dd * 100,
                calmar=calmar, sharpe=sharpe)
