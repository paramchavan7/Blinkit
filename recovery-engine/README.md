# Recovery Engine v2

One product for the journey from the call: **Diagnose → Prescribe → Suggest crew → SM plans → Execute → Close shift → Measure**,
with three views: **SM plan** (Today), **CM review** (Cluster review), **PM control tower**.

North star: the SM only allocates people and hours. The engine says what to do, where, and who is best at it.
The CM can see whether those man-hours worked. Suggested, planned and actual are tracked separately, the same way the roster is.

## What it does

| Step | What the user sees | Logic (Core.gs) |
|---|---|---|
| Diagnose | Severity (BROKEN / AT_RISK / SORTED) with reasons, the recommended recovery level, a stacked bar of variance by level, and where the variance comes from | `severity`, `diagnose`: an item goes to the coarsest broken unit holding one of its locations. A broken rack has ≥4 variance items **or** ≥3 locations with repeated stock corrections (from LOCATION_RECOVERY_RAW). A broken aisle has ≥3 broken racks. ≥3 broken aisles → advise full reconciliation |
| Prescribe | Ordered task list (Aisle reset / Rack sweep / Location check / Item search), each with the reason, item watch-list, locations and hours | Rack sweeps are sized from the real location count of the rack. Time = 4.7 measured min per location ÷ 0.4 (your V2 constants, e.g. 3 h ≈ 15 locations) |
| Suggest crew | Best captains present at T-1, **already ticked**, with hours | `auditMetrics` from AUDIT_EXECUTION_RAW: IAPH, QAPH, bad-audit % (BELOW_PROVISIONAL_SOP). Score = speed × accuracy. Sweeps go only to the more accurate half. Captains with >50% bad audits are never suggested |
| SM plans | Untick, change hours, add a name, skip a task. Suggested vs your plan updates live. A reason is required only when the SM changes the suggestion | Same `allocate` runs in the browser and on the server. The suggestion is stored next to the plan, never imposed |
| Execute | One card per captain, with a **Copy WhatsApp brief** button (tasks, locations, items, HHD steps) | Steps come from the `SOP` tab (draft, for Rahul to replace) |
| Close shift | Actual hours and done/partial/not-done per task, per captain | Append-only `ACTUALS` |
| Measure | Suggested / Planned / Actual triad, crew overlap, **planned locations audited (from audit data, not the SM's word)**, items recovered (feed), ₹ per man-hour, T+3/T+7 store variance, nudge vs region | `measure`, `observed`, `verify` |
| CM | Stores sorted by flag: NO_ACTUALS, LOW_EXECUTION, LOW_ADHERENCE, RELAPSED, NO_YIELD, NO_PLAN. Decision + owner logged | `flag` |
| PM | Region roll-up (hours S/P/A, ₹ recovered, ₹/h, pending Δ 7d), BROKEN vs CONTROL cohort, store list | `tower` in Service.gs |

## Files
- `Core.gs`: pure logic (also sent to the browser so plan edits are instant)
- `Service.gs`: orchestration over a repo interface (same code in Apps Script, tests and preview)
- `Server.gs`: Google Sheets repo + web app entry points
- `App.html`: the UI
- `test/`: `node test/fixture.js <exports dir>` then `node test/run.js` (end-to-end on real exports)
- `preview/build.js`: `node preview/build.js` → `preview/index.html` opens in any browser with no deploy

## Install (about 15 min)
1. New Google Sheet "Recovery Engine". Go to Extensions → Apps Script and add the files `Core`, `Service`, `Server` (script) and `App` (HTML).
2. Run `RE_SETUP` once. It creates the tabs and seeds `CFG` and `SOP`. Then run `RE_INSTALL_TRIGGER` (daily 10:00 snapshot).
3. Paste your exports into the input tabs. Paste them as they are: only the columns below are required, and extra columns are ignored.

| Tab | Paste | Required columns |
|---|---|---|
| `IN_STORE_HEALTH` | PILOT_COHORT (+ optional open_variance_3m, net_variance_2m, low_order_window) | outlet_id |
| `IN_CAPTAINS` | EMPLOYEE_CAPACITY_SYNC_RAW (+ optional `complex_approved` Y/N) | outlet_id, employee_name |
| `IN_LOCATIONS` | LOCATION_RECOVERY_RAW | outlet_id, location_id |
| `IN_AUDITS` | AUDIT_EXECUTION_RAW (last 30 days is enough) | audit_date_ist, outlet_id, auditor_id, session_elapsed_seconds |

   Variance stays in C: RAWItemlevel and Store_Master are read-only from `source_sheet_id`.
4. In `CFG`, set `pilot_outlets` (the 10 IDs), `cm_emails`, `pm_emails` and `recovery_app_url`.
5. Deploy → Web app, Execute as **Me**, access **anyone in the org**. Open `/exec?store=<outlet_id>`.

## Provisional (needs your data, not more code)
- Severity thresholds `sev_broken_pending` / `sev_broken_open_3m`: placeholders until you supply the 3-month open and 2-month net variance query.
- Broken rack / aisle thresholds (4 items, 3 unstable locations, 3 racks).
- Variance-source buckets (pilferage-prone / misplaced / never audited): rule-based placeholders until Rahul's documented cases replace them.
- SOP steps: a draft written without seeing the HHD. Replace the rows in the `SOP` tab.

## Scale notes (800 stores)
CM and PM views compute live from RAW and the input tabs. That is fine for the 10-store pilot. Before scale, move the per-store
measure into the daily job (write a results tab) and filter `IN_AUDITS` to 30 days. The Service layer is already split so this is a
repo change, not a rewrite.
