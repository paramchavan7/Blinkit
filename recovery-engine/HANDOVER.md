# Handover: Recovery Engine (replaces IRD V0.6)

For: Claude in Chrome, picking this up in Param's browser.
From: Claude Code. The code lives in GitHub repo `paramchavan7/Blinkit`, branch `claude/zealous-archimedes-qrqrcq`, folder `recovery-engine/`.
Owner: Param Chavan (PM, UPW & UK; not a coder). North go-live: **22 Oct 2026** (access for all North stores), mandatory planning in waves from 24 and 27 Oct (ROLLOUT_PLAN.md).

Read this file to the end before touching anything.

---

## 1. Your role from here: operator, not author

Param has already spent about $40 on a build (IRD V0.6) that didn't do what he asked. The code is now built and tested outside the browser. What's left is mostly **browser work**:
- pasting code into Apps Script;
- running the menu items and reading the errors;
- forking queries in Redash;
- filling sheet tabs and deploying.

Rules:
1. **Do not rewrite the engine** or restart from V0.6. The design below was agreed with Param point by point.
2. **Do not edit code directly in the Apps Script editor** unless Param asks. The pasted `Code.gs` is generated from 3 source files and covered by tests. An edit made in the browser drifts from the repo and won't be tested. If you find a bug:
   - copy the exact error text, the line number and the 5 lines around it;
   - write it up for Param to send to Claude Code.
3. Never question the store manager (SM) in the UI. No reason prompts. That was an explicit instruction.
4. Report outcomes honestly. If something fails, say so with the exact error.

---

## 2. Where V0.6 went wrong (so it doesn't happen again)

The root cause was a process failure, not just bad code. The spec existed only in a long Hindi/English call transcript, and the agent filled the gaps with its own assumptions.

| What Param asked for (from the call) | What V0.6 built |
|---|---|
| **Diagnose** each store's severity, and the recovery level: item/location, rack or aisle | No store severity at all. Items were only grouped into location packages, capped at 4 racks a day (`max_racks_per_day`). No rack sweep or aisle reset logic. |
| Use Parth's LiveHealth (PPI / TFR) | `show_ppi_tfr` defaulted to **off**, so the app ran on variance only |
| **Suggest the crew**: the best auditors by IAPH, QAPH and bad-audit % | No skill ranking. "Tightest-fit" bin-packing by hours only, from names the SM typed in |
| The SM plans, and is never imposed on or questioned | `require_change_reason = true`: the SM had to justify every change |
| Measure suggested vs planned vs actual | Only tracked plan lines against the feed. No suggestion stored, no actual hours per captain, no close-shift step |
| SM, CM and PM views (control tower) | Only the SM and a CM queue. No region roll-up, no BROKEN vs CONTROL cohort |
| An independent build | Read C's sheet across files (`source_sheet_id`), which broke whenever access or the schema changed |
| Built on the real data | Assumed C's schema (`update_date`, `audit_*` columns). The real RAWItemlevel has neither, so it would have failed on the first call |
| Backend visible and editable in the sheet, like Parth's | Settings were there, but there was no single action log and no data-health check |

**Lesson for you:** check every assumption against real exports and against Param's words. Don't fill gaps silently. When a threshold isn't known, make it a setting and label it provisional.

---

## 3. What exists now

**The product journey:**
1. **Diagnose:** store severity and the recovery level.
2. **Prescribe:** an ordered task list (aisle reset / rack sweep / location check / item search), with reason, items, locations and hours.
3. **Suggest crew:** pre-ticked best captains, with hours.
4. **SM plans:** untick, change hours, add a name, skip a task. Changes are recorded automatically and never questioned.
5. **Execute:** printable Google Sheet with one A4 page per captain, plus a PDF.
6. **Close shift:** actual hours and done / partial / not done.
7. **Measure:** suggested / planned / actual, plus audit evidence and ₹ recovered.

**Views:**
- SM: *Today*, *Store results*
- CM: adds *Cluster review*
- PM: adds *Control tower* and *Settings & log*

**Files** (all in `recovery-engine/`):

| File | What it is |
|---|---|
| `deploy/Code.gs`, `deploy/Engine.gs`, `deploy/Service.gs` | The 3 script files to paste into Apps Script (names Code / Engine / Service), each ending with `// ===== END OF …`. Built by `tools/bundle.js` from `Code.gs`, `IRD_Core.gs`, `IRD_Service.gs` |
| `deploy/App.html` | The UI. In Apps Script it must be an HTML file named exactly **App** |
| `deploy/*.sql` | North queries: NORTH_OUTLETS, RAWItemlevel_north, STORE_VARIANCE_DAILY, AUDIT_SESSIONS_north, AUDITOR_DAILY_north, LOCATION_RACKS_north (+ _lite backup) |
| `deploy/STORE_MASTER.tsv`, `PILOT_COHORT.tsv`, `USERS.tsv` | Ready tables / templates: paste into cell A1 of the matching tab |
| `SETUP_GUIDE.md`, `HANDOFF_CHROME.md`, `ROLLOUT_PLAN.md`, `TRAINING.md`, `METRICS.md`, `PARTH_DEMO.md` | Setup, the browser execution list, rollout, training, metrics, demo |

**Copy page:** https://claude.ai/artifact/S5dMhYmry6sQ9pcJpwciVf
Private to Param. It has every file above with Copy buttons and the Parth fork steps. **Use it to paste code.** Don't retype code or select it by hand.

**What `Recovery Engine → 1. Set up / repair tabs` creates in the sheet:**
- **Blue input tabs:** RAWItemlevel, STORE_VARIANCE_DAILY, STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW
- **Green backend tabs:** CFG (settings), USERS, SOP (printed captain steps), HEALTH, PLANS (with `changes_vs_suggested`), PLAN_TASKS (kind S = suggested, P = planned), PLAN_ITEMS, ACTUALS, CM_REVIEWS, ACTION_LOG, DAILY
- A **START_HERE** tab

Other menu items: `2. Check data health`, `3. Turn on daily 10:00 job`, `Clear cached inputs`.

**Rules engine.** Every number below is in the CFG tab and editable in-app; Parth's values are the defaults.
- **Severity** is the worse of two rules:
  - Parth's LiveHealth rule: PPI above 18 s **and** TFR below 99.5% = SEVERELY_BROKEN; one of the two = BROKEN.
  - The variance rule: pending ₹ ≥ 150k, open variance (gross negative, 90 days) ≥ 400k, net loss over 60 days, T-1 negatives. *These ₹ lines are provisional.*
- **Capacity:** R2A above 30 s and/or surge above 2%.
- **Broken rack:** at least 4 variance items, **or** Parth's V1 full-rack rule.
  - The V1 rule: direct targets are ≥25% of the rack's locations, or any-signal locations are ≥50%.
  - Direct target = location PPI more than 2 s above ideal, or ≥2 correction days in 7.
- **Broken aisle:** ≥3 broken racks. ≥3 broken aisles → advise full reconciliation. *(Provisional; Parth had no aisle rule.)*
- **Hours:** 4.7 measured minutes per location ÷ 0.4.
- **Captain score:** speed (IAPH vs store median, clamped 0.6–1.6) × (1 − bad-audit %).
  - Rack and aisle sweeps go only to the more accurate half of the store, or captains at ≤5% bad audits.
  - Captains above 50% bad audits are never suggested.
- **Audit evidence:** every session on the plan date is classed as BASELINE / OFF_PLAN / QUALITY_GAP (<80% coverage) / MATCHED, by comparing its end time with the plan's `confirmed_at`.

**Testing done** (by Claude Code):
- An end-to-end Node test passes on Param's real exports for all 10 pilot stores, plus real RAWItemlevel rows for 7076.
- The bundle compiles, and the copy page's contents were checked byte for byte against the files.
- **It has never run inside real Apps Script.** That is the job now.

---

## 4. Current status (v3, 21 Oct): built for every North store
- **Done and tested (outside the browser):**
  - unit / end-to-end tests: `node test/run.js`, `node test/lean_feed.js`;
  - the **Apps Script simulator**, which runs the real deploy files: `node test/gas_e2e.js`;
  - a **200-store scale run**, `node test/gas_scale.js`: refresh ≈ 200 API calls; SM screen ≈ 2 s; CM ≈ 1.6 s; tower ≈ 1.2 s (estimates; the first real JOB_RUNS gives the true time).
- **New in v3:**
  - an hourly precompute (STORE_STATE, PLAN_RESULTS, METRICS_DAILY, JOB_RUNS);
  - **who is on the floor now** (from the hourly audit export), and **racks with most variance** with Do first;
  - login checks by USERS (SM = outlet, CM = regions or outlets), with `restrict_sm_to_users` on by default;
  - `live_regions` for waves;
  - monitoring: the Monitoring tab, email alerts, error logging, nightly archive;
  - goodness metrics (METRICS.md);
  - North-scale queries: scope block, plus wrappers over Parth's queries (rack-level locations, per-auditor audits, two-day sessions);
  - the deploy is split into 3 script files (Code, Engine, Service) + App, each with an END line, because of the earlier cut-off paste.
- **Not done (needs the browser and people):** everything in **HANDOFF_CHROME.md**. That is the execution list.

## 5. Next steps
Follow **HANDOFF_CHROME.md** in order. Rollout dates, owners and risks: **ROLLOUT_PLAN.md**. Training: **TRAINING.md**. Parth demo: **PARTH_DEMO.md**. Click-level setup: **SETUP_GUIDE.md**.

## 6. Open decisions (Param's call, not yours)

- Severity ₹ thresholds (`sev_broken_pending`, `sev_broken_open_3m`) are placeholders.
- Confirm what "open" and "net" variance meant in the call. Currently open = gross losses over 90 days; net = gains − losses over 60 days.
- Broken-rack (4 items) and broken-aisle (3 racks) thresholds are guesses.
- The SOP tab holds draft handheld steps. Rahul's ground documentation should replace them.
- Before switching to `RAWItemlevel_with_audits.sql`, confirm the quantity column and the increment event name in `storeops.inventory_update_log`.
- Advice already given to Param: go live on 2 stores first, not 10. For 800 stores, CM/PM views need a daily results job, because computing live will time out.

---

## 7. Things the data taught us (don't relearn them)

- RAWItemlevel has no `update_date` or `audit_*` columns. Priority falls back to rank (TOP25 / TOP100).
- `INTERIM_LOCATION` and `DAMAGED_LOCATION` appear in the location arrays. They are filtered out, because a captain can't walk to them.
- The original query 2 output about 2,000 rows per store, with empty arrays past rank 200. It now selects `from ranked_capped`.
- NEG locations come from `INV_AUDIT_DEC`, meaning *an audit found it short there*, not a pick failure.
- **The fastest auditors are often the least accurate.** At 7184, the 158.7-IAPH captain has 96.9% of audits below SOP. Never rank on speed alone.
- The feed is month-to-date, so the 1st-of-month reset is not recovery (NEW_MONTH is excluded).

---

## 8. Resources

- **Code and docs:** https://github.com/paramchavan7/Blinkit/tree/claude/zealous-archimedes-qrqrcq/recovery-engine
- **Copy page:** https://claude.ai/artifact/S5dMhYmry6sQ9pcJpwciVf
- **Param's exports** (on his machine; sample data came from them):
  - PILOT_COHORT, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW, RECOVERY_PLAN_CURRENT and IREV2_SM_DRAFT(_ITEMS) CSVs from Parth's "Instore Recovery Engine V2" sheet;
  - a RAWItemlevel paste for 7076 / 7978.
- **Parth's code, for reference only:**
  - A_IRE_* (LiveHealth, RecoveryPlan, WorkAllocation, ControlTower);
  - B_IREV2_PrescriptionPreview;
  - IREV2_PilotExecution / ReviewServer;
  - C_Code.gs (C "UPW&UK Inventory Recovery App").
  - Parth's SQL was never shared. Get it from Parth's Redash.
- **V0.6 originals** (the failed build): INSTALL.md, IRD_Core.gs, IRD_Server.gs, IRD_App.html.
- **People:**
  - Parth Saluja: owns the V2 sheet and the queries.
  - Rahul: ground SOP documentation.
  - CMs: listed in CFG `cm_emails`.
