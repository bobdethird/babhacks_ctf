"""Variant overlays on top of the replicated Auto_8 allocation pipeline."""
import numpy as np
import pandas as pd
from engine import (load_data, compute_signals, auto8_alloc, run_portfolio,
                    metrics, CONFIGS)


def auto8_raw_pre_quant(df, sig, **kw):
    """Return Auto_8 a_risk (pre-quantization, pre-circuit-breaker)."""
    A, a_base, risk_on, cb_hit = auto8_alloc(df, sig, **kw)
    a_risk = np.maximum(a_base, risk_on)
    return a_risk, cb_hit


def finalize(df, a, cb_ret=-0.0475, cb_days=1, quant=0.10):
    """Quantize, then apply circuit breaker for cb_days days."""
    a_q = (a / quant).round() * quant
    P = df.xndx_close
    R = P / P.shift(1) - 1
    hit = (R <= cb_ret).fillna(False)
    block = hit.shift(1).fillna(False).astype(bool)
    for d in range(2, cb_days + 1):
        block = block | hit.shift(d).fillna(False).astype(bool)
    return a_q.where(~block, 0.0)


def vol_target_mult(df, sigma_star=0.35, lookback=20, floor=0.0, ddof=0):
    """Continuous multiplier min(1, sigma*/RV_lookback) on XNDX vol."""
    P = df.xndx_close
    r = np.log(P / P.shift(1))
    rv = r.rolling(lookback).std(ddof=ddof) * np.sqrt(252)
    m = (sigma_star / rv).clip(floor, 1.0)
    return m.fillna(1.0)


def dd_brake_mult(df, lookback=252, start=-0.05, full=-0.20):
    """Scale 1 -> 0 linearly as XNDX falls from `start` to `full` below its high."""
    P = df.xndx_close
    hi = P.rolling(lookback).max()
    dd = P / hi - 1
    m = ((dd - full) / (start - full)).clip(0, 1)
    return m.fillna(1.0)


def per_period(eq, freq='5YE'):
    rows = []
    grp = eq.groupby(pd.Grouper(freq=freq))
    for key, e in grp:
        if len(e) < 50:
            continue
        rows.append(dict(period=str(key.year), **{k: round(v, 2) for k, v in
                    metrics(e).items() if k != 'name'}))
    return pd.DataFrame(rows)


def evaluate(df, A, name, rebal_band=0.05):
    eq, ntr = run_portfolio(df, A, rebal_band=rebal_band)
    m = metrics(eq, name=name)
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    m['tpy'] = ntr / yrs
    return m, eq
