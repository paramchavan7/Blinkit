# Recovery Engine v3 (North)

One product for the journey from the call: **Diagnose → Prescribe → Suggest crew → SM plans → Execute → Close shift → Measure**,
with three views: **SM plan** (Today), **CM review** (Cluster review), **PM control tower**.

North star: the SM only allocates people and hours. The engine says what to do, where, and who is best at it.
The CM can see whether those man-hours worked. Suggested, planned and actual are tracked separately, the same way the roster is.

## What it does

| Step | What the user sees | Logic (Core.gs) |
|---|---|---|
| Diagnose | Severity (SEVERELY_BROKEN / BROKEN / AT_RISK / SORTED) = the worse of Parth's LiveHealth rule (PPI > 18 s, TFR < 99.5%) and the variance rule, plus capacity (R2A > 30 s, surge > 2%). All thresholds are in Settings. Also shows the recommended recovery level, a stacked bar of variance by level, and where the variance comes from | `severity`, `diagnose`: an item goes to the coarsest broken unit holding one of its locations. A broken rack has ≥4 variance items **or** passes Parth's V1 full-rack rule (direct targets ≥25% of the rack, or any-signal ≥50%; direct = PPI > ideal + 2 s or ≥2 correction days). A broken aisle has ≥3 broken racks. ≥3 broken aisles → advise full reconciliation |
| Prescribe | Ordered task list (Aisle reset / Rack sweep / Location check / Item search), each with the reason, item watch-list, locations and hours | Rack sweeps are sized from the real location count of the rack. Time = 4.7 measured min per location ÷ 0.4 (your V2 constants, e.g. 3 h ≈ 15 locations) |
| Suggest crew | Best captains present at T-1, **already ticked**, with hours | `auditMetrics` from AUDIT_EXECUTION_RAW: IAPH, QAPH, bad-audit % (BELOW_PROVISIONAL_SOP). Score = speed × accuracy. Sweeps go only to the more accurate half. Captains with >50% bad audits are never suggested |
| SM plans | Untick, change hours, add a name, skip a task. Suggested vs your plan updates live. **The SM is never asked why.** What changed is recorded automatically (`changes_vs_suggested`) | Same `allocate` runs in the browser and on the server. The suggestion is stored next to the plan, never imposed |
| Execute | **Printable sheet: one A4 page per captain** (tasks, locations in bold mono, items + qty, tick boxes, found-qty column, HHD steps, signatures), as a Google Sheet + PDF, or "Print here" | `printPages` model; steps come from the `SOP` tab |
| Close shift | Actual hours and done/partial/not-done per task, per captain | Append-only `ACTUALS` |
| Measure | Suggested / Planned / Actual triad, crew overlap, **planned locations audited (from audit data, not the SM's word)**, items recovered (feed), ₹ per man-hour, T+3/T+7 store variance, nudge vs region | `measure`, `observed`, `verify` |
| CM | Stores sorted by flag: NO_ACTUALS, LOW_EXECUTION, LOW_ADHERENCE, RELAPSED, NO_YIELD, NO_PLAN. Decision + owner logged | `flag` |
| PM | Region roll-up (hours S/P/A, ₹ recovered, ₹/h, pending Δ 7d), BROKEN vs CONTROL cohort, store list | `tower` in Service.gs |

**Install: [SETUP_GUIDE.md](SETUP_GUIDE.md)** · **Execute in the browser: [HANDOFF_CHROME.md](HANDOFF_CHROME.md)** · Rollout: [ROLLOUT_PLAN.md](ROLLOUT_PLAN.md) · Training: [TRAINING.md](TRAINING.md) · Metrics: [METRICS.md](METRICS.md) · Parth demo: [PARTH_DEMO.md](PARTH_DEMO.md)

## Scale (v3)
An hourly job (`refresh` in IRD_Service.gs) reads every input once and writes STORE_STATE (one row per store: summary + the SM screen, gzip-packed),
PLAN_RESULTS, DAILY, METRICS_DAILY and JOB_RUNS. Screens read those tabs (TextFinder lookups per store), so they stay around 2 s at 200 stores.
Tests: `node test/run.js` (logic), `node test/gas_e2e.js` (deploy files in an Apps Script simulator), `node test/gas_scale.js 20` (200 stores).

## Files (names match the IRD V0.6 Apps Script project)
- `IRD_Core.gs`: pure logic (also sent to the browser so plan edits are instant)
- `IRD_Service.gs`: orchestration over a repo interface (same code in Apps Script, tests and preview); every write goes to ACTION_LOG
- `Code.gs`: Google Sheets backend, sheet menu, health check, printable sheet export, web app entry points
- `IRD_App.html`: the UI (SM Today, Store results, CM Cluster review, PM Control tower, PM Settings & log)
- `test/`: `node test/fixture.js <exports dir>` then `node test/run.js` (end-to-end on real exports)
- `preview/build.js`: `node preview/build.js` → `preview/index.html` opens in any browser with no deploy

## Provisional (needs your data, not more code)
- Variance severity thresholds `sev_broken_pending` / `sev_broken_open_3m`: placeholders until you supply the 3-month open and 2-month net variance query (Parth's PPI/TFR rule is live).
- Broken rack by variance items (4) and broken aisle (3 broken racks) are my thresholds; Parth had no aisle rule. All are settings.
- Variance-source buckets (pilferage-prone / misplaced / never audited): rule-based placeholders until Rahul's documented cases replace them.
- SOP steps: a draft written without seeing the HHD. Replace the rows in the `SOP` tab.

