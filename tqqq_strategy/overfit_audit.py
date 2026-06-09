"""Overfit audit of the Auto_8/Auto_9 family.

Re-tunes the pipeline's key parameters on each half of the history and
evaluates on the other half. Reports:
  - canonical params vs split-tuned params, on both halves
  - Spearman rank correlation of parameter-set performance across halves
    (measures whether tuning transfers or is noise-fitting)
"""
import itertools
import numpy as np
import pandas as pd
from research_v2 import load_data, run_portfolio, metrics, IS_END, OOS_START

CONFIGS = [
    (14, 0.020, 300, 42), (18, 0.020, 300, 42), (21, 0.020, 175, 126),
    (14, 0.022, 300, 42), (14, 0.015, 80, 42), (14, 0.015, 80, 63),
    (21, 0.020, 300, 42), (18, 0.020, 225, 126), (21, 0.020, 150, 126),
    (18, 0.020, 175, 126),
]

df = load_data()
P = df.xndx_close
r = np.log(P / P.shift(1))
rv252 = r.rolling(252).std(ddof=0) * np.sqrt(252)

_ma_cache, _mom_cache = {}, {}


def gate(cond, valid):
    g = cond.astype(float)
    g[~valid] = 1.0
    return g.values


def ma_gate(m):
    if m not in _ma_cache:
        ma = P.rolling(m).mean()
        _ma_cache[m] = gate(P > ma, ma.notna())
    return _ma_cache[m]


def mom_gate(k):
    if k not in _mom_cache:
        pk = P.shift(k)
        _mom_cache[k] = gate(P > pk, pk.notna())
    return _mom_cache[k]


T1 = []
for (w, th, m, k) in CONFIGS:
    sd = r.rolling(w).std(ddof=0)
    T1.append(gate(sd < th, sd.notna()) * ma_gate(m) * mom_gate(k))

VXN_OK = (df.vxn <= 0.40).astype(float)
VXN_OK[df.vxn.isna()] = 0.0
VXN_OK = VXN_OK.values
RV = rv252.values
RV_VALID = rv252.notna().values
CB_HIT = ((P / P.shift(1) - 1).shift(1) <= -0.0475).fillna(False).values


def alloc(bull_ma, bull_mom, blend_lo, blend_w, riskon_rv, def_frac, lev):
    b = np.clip((np.nan_to_num(RV, nan=0.0) - blend_lo) / blend_w, 0, 1)
    u = 1 - b
    t2b = ma_gate(bull_ma) * mom_gate(bull_mom)
    t2br = ma_gate(300) * mom_gate(252)
    s = 0.0
    for t1j in T1:
        s = s + u * np.maximum(t1j, t2b) \
              + b * np.maximum(t1j, def_frac * t2br * (t1j == 0))
    a_base = s / 10
    lowrv = np.where(RV_VALID, (RV <= riskon_rv).astype(float), 1.0)
    riskon = VXN_OK * lowrv * ma_gate(300) * mom_gate(126)
    a = np.maximum(a_base, lev * riskon)
    a_q = np.round(a / 0.10) * 0.10
    return pd.Series(np.where(CB_HIT, 0.0, a_q), index=df.index)


GRID = dict(
    bull_ma=[30, 40, 50, 60],
    bull_mom=[10, 15, 21],
    blend_lo=[0.24, 0.28, 0.32],
    blend_w=[0.10, 0.14],
    riskon_rv=[0.14, 0.16, 0.18],
    def_frac=[1 / 3, 0.5, 2 / 3],
    lev=[1.0, 1.3],
)


def main():
    dfA = df.loc[:IS_END]
    dfB = df.loc[OOS_START:]
    keys = list(GRID)
    rows = []
    for vals in itertools.product(*GRID.values()):
        p = dict(zip(keys, vals))
        A = alloc(**p)
        eqA, _ = run_portfolio(dfA, A.loc[:IS_END])
        eqB, _ = run_portfolio(dfB, A.loc[OOS_START:])
        mA, mB = metrics(eqA), metrics(eqB)
        rows.append({**p,
                     'A_cagr': mA['cagr'], 'A_dd': mA['maxdd'],
                     'A_calmar': mA['calmar'],
                     'B_cagr': mB['cagr'], 'B_dd': mB['maxdd'],
                     'B_calmar': mB['calmar']})
    out = pd.DataFrame(rows)
    out.to_csv('data/overfit_audit_grid.csv', index=False)
    print(f'{len(out)} parameter sets evaluated on both halves')
    print('Spearman rank corr (calmar A vs B):',
          round(out.A_calmar.corr(out.B_calmar, method='spearman'), 3))
    print('Spearman rank corr (cagr A vs B):',
          round(out.A_cagr.corr(out.B_cagr, method='spearman'), 3))


if __name__ == '__main__':
    main()
