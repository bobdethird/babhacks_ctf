# Auto_9: Improving the Auto_8 TQQQ Strategy

## Summary

Auto_8 was replicated exactly (0 target-allocation mismatches on all 10,388
days of the provided daily log, identical 1,274 trades, identical max
drawdown). Two changes produce **Auto_9**, which strictly dominates Auto_8;
a scaled variant **Auto_9C** offers a large risk reduction instead.

| Strategy | CAGR | Max DD | Calmar | Sharpe | Trades/yr | Roll-5y median CAGR | Roll pass 25/50 |
|---|---|---|---|---|---|---|---|
| Auto_8 (baseline) | 39.44% | -47.20% | 0.835 | 0.983 | 30.9 | 35.9% | 26/37 |
| **Auto_9** | **40.92%** | **-47.20%** | **0.867** | 0.978 | 31.0 | **39.3%** | **28/37** |
| **Auto_9C (0.8x)** | 34.68% | **-39.88%** | **0.870** | 0.978 | 30.4 | — | — |

Auto_9 figures already include a fed-funds + 1.5% borrow spread on levered
days; the result is insensitive to spread (40.87% CAGR even at +3%).

## The two changes

1. **`defensive_frac`: 1/3 → 1/2.** The bear-regime T2 allocation. The
   sensitivity grid is smooth and slightly upward in this direction
   (no cliff); 1/2 adds ~0.34pp CAGR at identical max DD.

2. **Risk-on leverage 1.3.** When the canonical risk-on override fires
   (VXN ≤ 40%, RV252 ≤ 16%, XNDX > MA300, MOM126 > 0) the target becomes
   130% TQQQ instead of 100%, borrowing the extra 30% at fed funds + spread.
   This state is the highest-quality state in the sample (lagged Sharpe ~1.5,
   14.8% of days, never adjacent to a drawdown trough), so the extra
   exposure raises CAGR ~1.2pp with **literally unchanged max drawdown**
   up to lev 1.3 (at 1.4 the DD worsens slightly — 1.3 is the dominance
   boundary). The grid over def_frac × lev is monotone/smooth — not a
   fitted spike. Note: leverage requires margin (or an equivalent stacked
   instrument); if that is unacceptable, def_frac=1/2 alone still gives
   39.77%/-47.20%/0.843, a small free improvement.

   Important: keep the VXN gate strict (missing VXN ⇒ no risk-on). Letting
   pre-2001 days qualify pushes max DD to -59% because RV252 was calm and
   trend strong right before the 1987 crash.

3. **Auto_9C**: multiply all Auto_9 targets by 0.8 (before quantization).
   If the goal is lower risk rather than higher CAGR: max DD improves
   7.3pp (-47.2% → -39.9%) and Calmar still beats Auto_8.

## Why the drawdown can't easily be cut without paying for it

The worst episode (Aug 1997 – Jan 1998) is not a crash: XNDX fell only
-11%, but the strategy lost -47% via 30 allocation flips in 119 days —
3x whipsaw bleed. Every overlay that suppresses this also suppresses the
fast re-entry that drives the strategy's rebound capture, and costs more
CAGR than it saves in DD. Auto_8 sits near the efficient frontier of its
signal family; the only "free" moves found are the two above.

## What was tested and did NOT work (60+ variants)

All evaluated on the full 1985–2026 log with identical accounting:

- **Vol-target overlays** (σ*/RV20 scaling, lookbacks 15–30, targets
  0.30–0.45): DD unchanged, CAGR -0.4 to -1.4pp. The DD isn't from crash
  exposure, so vol scaling only drags.
- **Drawdown brakes** (scale by XNDX distance from 252d high): CAGR -4 to
  -8pp for ≤2.5pp DD relief. Calmar much worse.
- **EMA smoothing of the allocation** (spans 3–20, incl. asymmetric
  fast-down/slow-up): CAGR -4 to -11pp, DD *worse*. Slow re-entry misses
  3x rebounds.
- **Churn/flip-count filters**: CAGR -9 to -17pp.
- **Consensus convexity** (a_base^p): mild DD relief (-44.9% at p=2) but
  CAGR -1.8pp; Calmar flat.
- **Downside semi-vol** replacing total vol (regime, T1, risk-on, all):
  neutral to worse everywhere.
- **TQQQ own-trend caps** (cap alloc when TQQQ < its own MA40–150):
  CAGR -4 to -16pp. Vol-drag detection is real but rebound cost dominates.
- **Circuit-breaker changes**: removing it costs -1.5pp CAGR (it earns its
  keep: the post-crash days it skips have positive *mean* but negative
  *log-mean*); contrarian "buy the CB day" is much worse (-78% DD at full
  size); 2-day duration costs -1.2pp.
- **Blend-window shifts / blend powers** (0.30–0.45 bounds, b^1.5–b^3):
  neutral to worse.
- **Bear-gate variations** (MA200–300 × MOM126–252): all slightly worse.
- **Asymmetric/wide rebalance bands, vol-conditional rate limiters,
  finer quantization (0.05)**: neutral to slightly worse.
- **Equity-curve brakes** (de-risk when own equity in DD): CAGR -3 to -6pp.
- **Tiered exposure floors in mid-calm regimes**: DD blows out to -60%.

A caution on conditional analyses: same-day gate/return tables show huge
Sharpe (e.g. "bear regime + fast bull trend = Sharpe 3.9") that fully
evaporates once gates are lagged one day as traded. Any future idea should
be evaluated lagged, inside the full backtest.

## Files

- `auto9.py` — final strategy. `--replicate` verifies the Auto_8 match,
  `--scale 0.8` runs Auto_9C.
- `engine.py`, `variants.py` — replication engine and the overlay test bed.
- `data/auto9_sensitivity.csv` — def_frac × leverage grid.
- `data/auto9_daily_log_scale{1.0,0.8}.csv` — daily logs of both variants.

Data inputs (`data/daily_log.csv` etc.) are the user-provided Auto_8 logs;
fed funds rates are recovered from the log's own cash accrual.
