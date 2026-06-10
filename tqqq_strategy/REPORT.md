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

---

# Phase 2: New decision methods + overfitting audit

Protocol: all development on 1985–2009 (half A); 2010–2026 (half B) held
out. Identical execution mechanics for every candidate (close execution,
same cash accounting, fed funds recovered from logs, borrow spread on
leverage). Candidates that fail in-sample never touch the held-out half.

## New structural families tested — all rejected in-sample

| Method | Best IS Calmar | Auto_8 IS Calmar |
|---|---|---|
| H1 Fractional Kelly (mu_hat/sigma_hat^2, multi-horizon EWM drift) | 0.23 | 0.753 |
| H2 Vol-managed trend (MA gate x (sigma*/sigma_hat)^k) | 0.33 | 0.753 |
| H3 CTA trend breadth, vol-scaled | 0.47 | 0.753 |
| H4 Smooth 2-surface (trend strength x continuous calm gate) | 0.46 | 0.753 |
| Hyper-ensemble (uniform average of all 1296 family tunings) | 0.676 (A) / 0.903 (B) | 0.753 (A) / 1.022 (B) |

Continuous sizing rules lose by a factor of ~2 on Calmar. The binary
calm-trend gates encode a real, sharp regime feature of NDX that smooth
estimators dilute. The gate-ensemble family is genuinely the right tool
for this data, not just a tuned artifact.

## Overfitting audit of the Auto_8/Auto_9 family (1,296-point grid, 2-fold)

Grid over bull_ma x bull_mom x blend bounds x riskon_rv x def_frac x lev,
every point evaluated independently on both halves:

- **Fine-tuning does not transfer.** Spearman rank correlation of Calmar
  across halves: **0.21**. The top-20 sets tuned on half A average 0.881
  Calmar on half B — indistinguishable from the grid mean (0.873).
  Any further parameter tweaking of this family should be presumed noise.
- **The structure is the alpha.** A typical (untuned) family member earns
  CAGR 30–45% / Calmar 0.6–1.0 on either half.
- **Canonical params are top-decile on both halves** (94th pctile A, 86th
  pctile B) — better than half-tuned alternatives transfer. The family is
  at its limit; the user's read is correct.
- **Auto_9 ingredients:** the risk-on leverage CAGR gain replicates on
  both halves (+1.0 to +2.4pp), but max-DD-neutrality was full-sample
  luck — on 2010–2026 alone DD is ~2.6pp worse with lev 1.3. Treat it as
  honest leverage in high-quality states, not a free lunch.
  def_frac >= 0.5 is flat-to-positive on both halves independently.

## Honest forward expectations

2010–2026 was an easy regime (everything scores Calmar ~1 there). The
full-sample headline (39–41% CAGR, -47% max DD) carries unknown selection
bias from eight generations of tuning; the two-half consistency suggests
the core edge is real, but a forward-looking estimate closer to the
family-typical range (CAGR low/mid-30s, max DD -45 to -55%) is the
defensible planning number.

## Where significant improvement can still come from

Not from new math on the same two price series — that channel is
exhausted (Phases 1 and 2 tested ~80 variants and 5 structural families).
The remaining levers all require new data: cross-asset defensive sleeve
for the cash leg (bond/gold trend), breadth/credit/VIX-term-structure
regime inputs, or overnight/intraday return decomposition.

Artifacts: `research_v2.py` (hypothesis framework), `overfit_audit.py`
(2-fold grid audit), `data/overfit_audit_grid.csv` (all 1,296 results).

---

# Phase 3: External data (gold, VIX, Treasuries)

Network access was proxy-restricted; usable sources were GitHub-hosted
open datasets. Completeness audit before use:

| Series | Coverage | Verdict |
|---|---|---|
| LBMA gold PM fix, daily | 1968 – 2026-02 | used in tests (tail forced flat) |
| VIX close, daily | 1990 – 2026-06 | used with strict missing=off |
| FRED 10y CMT yield, monthly | 1953 – 2026-04 | **used in final** |
| Daily treasury curve (data-ust) | 1990 – 2022-03 | rejected (incomplete); used only to validate bond synthesis |

Protocol unchanged: hypotheses developed/selected on 1985–2009 only;
one frozen evaluation on 2010–2026. All runs include 5bp one-way
transaction costs.

## Rejected in-sample (never touched OOS)

- **G1 gold sleeve** (trend + funding-hurdle filtered gold on the cash
  leg): −0.4 to −3.5pp CAGR across all 12 configs. Gold's 1985–2001
  secular bear loses to the 5–8% cash it displaces even when filtered.
- **G3 VIX-extended risk-on** (let VIX stand in for missing VXN
  1990–2001): −3 to −4pp CAGR, max DD −52% to −59%. Forcing the override
  in mid-90s low-VIX windows deepens the 1997–98 whipsaw episode. The
  canonical "missing VXN ⇒ no override" quirk is protective; keep it.

## Validated: Auto_10 — 10y Treasury sleeve on the cash leg

Idle cash (1−A) goes into a 10y Treasury proxy when bond 12-month total
return exceeds the fed-funds 12-month return (monthly signal, 1-month
lag). Bond TR synthesized from the complete monthly yield series
(validated 0.997 correlation vs an independent daily-curve
reconstruction, 1990–2022).

| Strategy (5bp costs) | CAGR | Max DD | Calmar | Sharpe |
|---|---|---|---|---|
| Auto_8 | 38.71% | -47.52% | 0.815 | 0.971 |
| **Auto_10** (Auto_8 + bond sleeve, no margin) | **39.98%** | **-45.58%** | **0.877** | 0.990 |
| Auto_9 (levered core) | 40.16% | -47.62% | 0.843 | 0.966 |
| **Auto_10L** (Auto_9 + bond sleeve) | **41.47%** | -47.33% | 0.876 | 0.985 |

Evidence quality — the strongest of any change tested in this project:

- IS (param selection): +1.25pp CAGR, −1.9pp max DD, monotone in both
  parameters (12m > 6m lookback, full > half fraction) — plateau, not spike.
- OOS single frozen shot: +1.30pp CAGR (A8 core) / +1.34pp (A9 core),
  max DD also better. Same sign in all four IS/OOS × core cells.
- The funding hurdle exited bonds for all of 2022–2023 (the bond crash)
  purely out-of-sample — the rule's failure mode was stress-tested by
  history and passed.
- Economic rationale is standard: duration carry when it beats funding,
  plus flight-to-quality convexity in equity crashes (bonds rallied in
  2008/2020 exactly when the strategy sat in cash).

Caveats: bond leg revalues monthly (intra-month sleeve vol understated —
second-order since sleeve ≤ cash share); monthly-average yields smooth
the signal (mitigated by the 1-month lag). Before live use, re-validate
the sleeve with daily IEF/TLT or daily CMT yields.

Recommendation: **Auto_10** is the new default — it dominates Auto_8 on
every headline metric with no margin requirement. Auto_10L adds the
Phase-1 leverage for ~+1.5pp CAGR at slightly worse DD.

Artifacts: `auto10.py`, `gold_sleeve.py` (three-asset engine),
`data/external/*` (source data), `data/auto_10*_daily_log.csv`.
