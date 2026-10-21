# Goodness metrics: is the engine worth the man-hours?

The hourly refresh writes these to **METRICS_DAILY** for every day (last 14 days are recomputed), for `ALL`, each `region:` and each pilot `cohort:`.
They are also shown in the app's Control tower. The per-plan detail behind them is in **PLAN_RESULTS**.

Rule of evidence: **audit data and the variance feed count; the SM's own log never counts as recovery.**

| Group | Metric (column) | Definition | Week-1 target | Why it matters |
|---|---|---|---|---|
| Adoption | `plan_rate_pct` | Stores with a confirmed plan that day ÷ live stores that need recovery (severity not SORTED) | ≥ 60% | No plan, no recovery |
| Adoption | `closed_pct` | Plans with actual hours logged ÷ plans (past days) | ≥ 70% | Without actuals there is no ₹ per man-hour |
| Adoption | `sm_views` | Stores whose app screen was opened that day | Rising daily | Leading indicator, before plans appear |
| Trust | `crew_overlap_pct` | Share of the suggested captains the SM kept | Watch, no target | Low values mean the suggestion doesn't match the floor (presence data stale, or the ranking needs tuning) |
| Trust | `hours_vs_suggested_pct` | Planned ÷ suggested man-hours | 70–110% | Far below means the SM under-staffs recovery; far above means the suggestion is too light |
| Execution | `actual_vs_planned_pct` | Actual ÷ planned man-hours | ≥ 80% | The plan was really worked |
| Execution | `audited_pct` | Planned locations with a **matched** audit (planned location, coverage ≥ 80%) ÷ planned locations | ≥ 60% | Proof the right places were counted, from audit data |
| Execution | `quality_gap_pct` | Planned-location audits under the coverage gate ÷ all planned-location audits | ≤ 20% | Counting badly is the same as not counting |
| Outcome | `recovered_value`, `recovered_items` | ₹ and items on planned SKUs that the feed shows recovered (audit increment after the plan, or open variance fell or cleared; month reset excluded) | Rising | The result |
| Outcome | `rupees_per_hour` | Recovered ₹ ÷ actual man-hours | Week-on-week ≥ week 1 | **Efficiency**: the headline |
| Outcome | `locations_per_hour` | Matched planned locations ÷ actual man-hours | ≥ 4 (SOP = 60 ÷ (4.7 ÷ 0.4) ≈ 5.1) | Man-hour productivity versus the V2 time standard |
| Outcome | `t7_better_pct` | Plans whose store absolute pending is lower 7 days after the plan date | ≥ 60% | It holds, not just a one-day dip |
| Outcome | BROKEN vs CONTROL (cohort scopes) | Pending change in the BROKEN cohort vs its CONTROL pair | BROKEN falls faster | Shows the recovery, not the season, moved it |

## "Man-hours saved": how to read it honestly
The app can't know how many hours a store would have spent without it. Three measurable proxies, all from PLAN_RESULTS:
1. **₹ per man-hour over time** for the same stores (week 1 is the baseline).
2. **Locations audited per man-hour** against the 5.1 per hour SOP standard.
3. **Suggestion vs no suggestion:** compare plans where the SM kept most of the suggested crew (`crew_overlap_pct` ≥ 67) with plans where they didn't. Look at `rupees_per_hour` and `audited_pct`.
   - If the kept-suggestion plans recover more per hour, the crew ranking saves hours.
   - This is the test to show Parth after 2 weeks.

## Go / no-go after week 1 (all must hold)
- `plan_rate_pct` ≥ 60% and `closed_pct` ≥ 70% on the ALL scope
- `audited_pct` ≥ 60% and `quality_gap_pct` ≤ 20%
- At least 95% of hourly refreshes OK (JOB_RUNS), and no `[system]` error left unresolved for more than 24 h (Monitoring)
- No region below 40% plan rate: if one is, Rahul retrains that region before the next wave
