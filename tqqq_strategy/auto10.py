"""Auto_10: Auto_8/Auto_9 TQQQ pipeline + 10y Treasury sleeve on the cash leg.

The TQQQ allocation is untouched. The idle cash (1 - A) is invested in a
10-year Treasury proxy whenever bonds pass an absolute-momentum funding
hurdle, measured monthly and applied with a 1-month lag:

    hold bonds in month m+1  iff  bond 12m total return (through m)
                                  > cash (fed funds) 12m total return

Bond total return is synthesized from the complete FRED monthly 10y
constant-maturity yield series (1953-2026) via par-bond duration; the
synthesis was validated at 0.997 monthly-return correlation against an
independent reconstruction from daily Treasury curve data (1990-2022).

Validation protocol: parameters (12m lookback, full-fraction sleeve) were
frozen on 1985-2009 only; 2010-2026 was evaluated once. The improvement
holds in both halves, on both the unlevered (Auto_8) and levered (Auto_9)
cores, and the hurdle exited bonds for all of 2022-2023 out-of-sample.

Usage:
  python3 auto10.py             # Auto_10  (Auto_8 core, no margin)
  python3 auto10.py --levered   # Auto_10L (Auto_9 core: def_frac .5, lev 1.3)
"""
import argparse
import numpy as np
import pandas as pd

import overfit_audit as oa
from gold_sleeve import run_three_asset
from research_v2 import metrics


def build_bond_tr(path='data/external/us10y_month.csv'):
    y = pd.read_csv(path, parse_dates=['Date']).set_index('Date')['Rate'] / 100.0

    def dur(yld):
        n, c = 20, yld / 2
        return ((1 - (1 + c) ** -n) / c) / 2 / (1 + c) if c > 0 else 10.0

    tr = [1.0]
    for i in range(1, len(y)):
        d = dur(y.iloc[i - 1])
        tr.append(tr[-1] * (1 + y.iloc[i - 1] / 12 - d * (y.iloc[i] - y.iloc[i - 1])))
    return pd.Series(tr, index=y.index, name='bond_tr')


def bond_sleeve_weights(df, A, bond, lookback_m=12):
    ffm = df.fedfunds.resample('MS').first().reindex(bond.index).ffill()
    cash_idx = (1 + ffm / 12).cumprod()
    gate_m = ((bond / bond.shift(lookback_m))
              > (cash_idx / cash_idx.shift(lookback_m))).astype(float).shift(1)
    gate = (gate_m.reindex(df.index.union(gate_m.index))
            .ffill().reindex(df.index).fillna(0.0))
    return (1 - A).clip(lower=0) * gate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--levered', action='store_true')
    ap.add_argument('--tc', type=float, default=0.0005,
                    help='one-way transaction cost on traded notional')
    args = ap.parse_args()

    df = oa.df
    core = dict(bull_ma=40, bull_mom=15, blend_lo=0.28, blend_w=0.10,
                riskon_rv=0.16)
    if args.levered:
        A = oa.alloc(**core, def_frac=0.5, lev=1.3)
        name = 'Auto_10L'
    else:
        A = oa.alloc(**core, def_frac=1 / 3, lev=1.0)
        name = 'Auto_10'

    bond = build_bond_tr()
    bond_daily = bond.reindex(df.index.union(bond.index)).ffill().reindex(df.index)
    G = bond_sleeve_weights(df, A, bond)

    Gd = {'price': bond_daily, 'weight': G}
    eq, ntr = run_three_asset(df, A, Gd, tc=args.tc)
    yrs = (df.index[-1] - df.index[0]).days / 365.25
    print(metrics(eq, name), 'trades/yr:', round(ntr / yrs, 1))

    out = pd.DataFrame({'tqqq_alloc': A, 'bond_alloc': G, 'equity': eq})
    fn = f'data/{name.lower()}_daily_log.csv'
    out.to_csv(fn)
    print('wrote', fn)


if __name__ == '__main__':
    main()
