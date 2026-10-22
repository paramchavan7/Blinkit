# Recovery Engine: what runs, what's missing, and the 2-hour go-live (22 Oct 2026)

## Part 0. Reconciled with Claude in Chrome's list (22 Oct, after Param's North master query)
| Point | Claude in Chrome said | Now |
|---|---|---|
| Scope | 51 fixed IDs; your UPW + UK master has 127 | **Closed.** Every query takes its stores from your North city list (6 regions). The `where region in (...)` line in each query switches regions on and off |
| STORE_MASTER regions / CMs | Empty tab, CM scoping broken, "Dehradhun" as a region | **Closed.** `STORE_MASTER_north.sql` (region, city, CM as cluster, SM, MISSING_CM / SM flags), synced daily |
| USERS | Only PMs; no SM / CM can log in | **Closed.** `USERS_north.sql` → USERS_AUTO (every SM / ASM / senior SM / CM / ops head / city admin with an email), synced daily. USERS stays for overrides |
| "Who is at the store now" | Audits in the last 90 minutes only | **Improved.** `FLOOR_NOW_north.sql`: open shifts (ops_management.shift) + anyone working today, hourly. On shift = on the floor |
| Store health | Off, so 0 BROKEN | **Partly closed.** Store PPI (picking) is live; TFR / R2A / surge still have no source |
| Eligible auditor pool (`complex_approved`) | No flag in user_details | **Closed by setting.** CFG `complex_approved_ids`: paste Parth's employee IDs |
| High-value SKU audits on top | Not in ranking | **Built.** Missing units worth ≥ ₹10,000 each rank first (HV). CFG `high_value_unit_rs` (0 = off) |
| Charter state names (BROKEN / DETERIORATING / CHRONIC / CLEAN) | App uses SEVERELY_BROKEN / BROKEN / AT_RISK / SORTED | **Open: your decision** (asked) |
| Severity ₹ lines (₹1.5L pending, ₹4L open) | Placeholders | **Open: you + Parth**, 2 CFG cells |
| Parth's V2 draft / review flow | Replaced, not ported | Show the swap in the demo |
| Side-by-side vs Parth's plan preview | Not done | Before the demo: 1 store |
| C's month-on-month by CM | Not in v3 | Next build |
| API key | Claude in Chrome may not enter it | **You** type it into "Connect Redash" |
| Sync time at 127+ stores | May pass 4 minutes | CSV download, today-only sessions, 20k-row writes, Redash schedules + `max_age_minutes`, and three daily sync runs that each continue where the last one stopped |


## Part 1. What we are running

### 1A. The Apps Script project (the base: what actually runs)
One Apps Script project, **bound to the app Google Sheet**. Live today as the Grofers project `1P3MoTV…`, on the /dev URL; not yet deployed.

| File in Apps Script | Type | What it does | Source in the repo (`recovery-engine/`) |
|---|---|---|---|
| **Code** | script | Sheet menu, setup, reading and writing tabs, the **Redash sync**, the hourly refresh job, alerts, archive, printable sheets, web-app entry points | `Code.gs` |
| **Engine** | script | Recovery logic: worklist, severity, diagnosis (rack / aisle), top racks, presence, crew ranking, allocation, measure, goodness metrics. Also sent to the browser | `IRD_Core.gs` |
| **Service** | script | The SM / CM / PM screens, confirm, actuals, refresh, results, monitoring, access rules | `IRD_Service.gs` |
| **App** | HTML | The app page (SM Today, Store results, CM Cluster review, PM Control tower, Monitoring, Settings & log) | `IRD_App.html` |

**How the deploy files are made:** `node tools/bundle.js` writes `deploy/Code.gs`, `deploy/Engine.gs`, `deploy/Service.gs` and `deploy/App.html`, each ending with an END line. Paste them only from the copy page: https://claude.ai/artifact/S5dMhYmry6sQ9pcJpwciVf

**Tests (run here, not in Apps Script):**
- `test/run.js`: logic end to end.
- `test/gas_e2e.js`: the 4 deploy files inside an Apps Script simulator, including a mock Redash.
- `test/gas_scale.js`: 200 stores.

### 1B. The Google Sheets
| Sheet | ID | Holds |
|---|---|---|
| **App sheet** ("Recovery Engine", bound to the script) | open it from the Apps Script project (Overview → container) | **Green tabs written by the app:** CFG, USERS, SYNC, SOP, HEALTH, PLANS, PLAN_TASKS, PLAN_ITEMS, ACTUALS, CM_REVIEWS, ACTION_LOG, DAILY, STORE_STATE, PLAN_RESULTS, METRICS_DAILY, JOB_RUNS, START_HERE |
| **Inputs sheet** | `1csiQryJr9_uJFLlh_qSzc-8Xu2ZUq6Wql-wzx3Ui0fo` (set it in CFG `inputs_sheet_id`) | **Blue input tabs filled by the Redash sync:** RAWItemlevel, STORE_VARIANCE_DAILY, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW, AUDITOR_DAILY. **Typed by you:** STORE_MASTER (which stores are live), PILOT_COHORT |
| **Recovery Engine Archive** | created automatically on the first nightly archive | Old PLAN_TASKS, PLAN_ITEMS, ACTION_LOG and JOB_RUNS rows |
| Printable captain sheets | one new Google Sheet per plan, in Drive (`export_folder_id`) | One A4 tab per captain + a PDF link |

### 1C. The Redash queries (Redash https://redash-queries.grofer.io, [Warehouse] Trino): 10, all scoped by the North city list
| Query | Tab | Sync | Feeds |
|---|---|---|---|
| `STORE_MASTER_north.sql` | STORE_MASTER (Inputs) | daily | Which stores are live: region, city, CM (cluster), SM |
| `USERS_north.sql` | USERS_AUTO (app sheet) | daily | Who can log in: SM → own stores; CM / ops head / city admin → their stores |
| `FLOOR_NOW_north.sql` | FLOOR_NOW | **hourly** | Who is at the store now: open shifts + anyone working today |
| `AUDIT_SESSIONS_north.sql` | AUDIT_EXECUTION_RAW | **hourly** | Today's location audits: evidence per planned location |
| `AUDITOR_DAILY_north.sql` | AUDITOR_DAILY | daily | Captain IAPH / QAPH / bad-audit %, last 8 days |
| `ROSTER_north.sql` | EMPLOYEE_CAPACITY_SYNC_RAW | daily | Captain list with names and designations; worked yesterday |
| `LOCATION_RACKS_north.sql` | LOCATION_RECOVERY_RAW | daily | Rack sizes and correction days (Parth's full-rack rule) |
| `RAWItemlevel_north.sql` | RAWItemlevel | daily | Item variance, locations, audit increment / decrement proof (**required**) |
| `STORE_VARIANCE_DAILY.sql` | STORE_VARIANCE_DAILY | daily | 90-day open / 60-day net variance (**required**) |
| `STORE_HEALTH_north.sql` | STORE_HEALTH_RAW | daily | Store PPI |

### 1D. What we took from each file you uploaded
| Your file | What the build uses from it | Status |
|---|---|---|
| **Call transcript** | The journey (diagnose → prescribe → suggest crew → SM plans → execute → close → measure), the 3 views, never questioning the SM, suggested vs planned vs actual | Built |
| `C_Code.gs`, `C_Index.html` (UPW&UK Recovery App) | Worklist rules ported 1:1: rank ≤ 200, P0–P4 negative priority, recovery status, array parsing; the RAWItemlevel schema | Built |
| Your RAWItemlevel paste + your 2 queries | The real feed schema; query fixes (top 200 only, INTERIM / DAMAGED removed); severity history | Built, now `RAWItemlevel_north` + `STORE_VARIANCE_DAILY` |
| `A_IRE_LiveHealth.gs` | Parth's thresholds: PPI 18 s, TFR 99.5%, R2A 30 s, surge 2% | Rule built. **PPI live today; TFR / R2A / surge have no source** |
| `A_IRE_RecoveryPlan.gs`, `RECOVERY_PLAN_CURRENT.csv` | V1 full-rack rule (direct ≥25% or signal ≥50%), rack sweep vs targeted scope, 4.7 min ÷ 0.4 time standard | Built (correction days only; no location PPI) |
| `A_IRE_WorkAllocation.gs` | 3 h max per captain, sweeps only for approved / accurate captains (`complex_approved`) | Built |
| `B_IREV2_PrescriptionPreview.gs` | PPI evidence handling, "preview is not a work order", the 4.7 / 0.4 caveat | Used as rules / labels |
| `IREV2_ReviewServer.gs` / `ReviewUI` / `PilotExecution*`, `IREV2_SM_DRAFTS(_ITEMS).csv` | The SM draft-plan shape (team, hours, selected and deferred locations) | Used as reference; replaced by our confirm / plan tabs |
| `A_IRE_ControlTower*.gs/html` | PM control tower idea | Rebuilt as Control tower + Monitoring |
| `PILOT_COHORT.csv` | 5 BROKEN / CONTROL pairs | Built (cohort comparison) |
| `AUDIT_EXECUTION_RAW.csv`, `EMPLOYEE_CAPACITY_SYNC_RAW.csv`, `LOCATION_RECOVERY_RAW.csv`, `STORE_HEALTH_RAW.csv` | **Column shapes and test data only** (Sept, Parth's 10 stores). Live data now comes from our own queries | Test data |
| V0.6 (`IRD_App.html`, `IRD_Core.gs`, `IRD_Server.gs`, `INSTALL.md`) | Feed-verified recovery logic (`verify`) | Ported; the rest replaced |
| `C_UPWUK_Dashboard_AutoBuild.gs`, `C_UPWUK_MoM_Dashboard_AutoBuild.gs`, `C_UPWUK_Monthly_Recovery_Engine.gs` | Not used (C's MoM dashboards) | Not in build |
| Engineering & Product Blueprint (pasted) | Quality bar: logging, settings in sheet, health checks, idempotency | Built |

### 1E. Not in the build yet but needed
Grouped by what it serves: Parth's expectations, your vision, your charter.

| Gap | Serves | Why it matters | What it needs | Effort |
|---|---|---|---|---|
| **TFR, R2A, surge** | Parth (LiveHealth) | Without TFR no store can be SEVERELY_BROKEN, and capacity (R2A / surge) is blank | The order-fill and cart tables (Parth's DAILY_STORE_HEALTH_SYNC_RAW query, or 2 table names) | 1 h once tables known |
| **Location PPI** (direct target = PPI > ideal + 2 s) | Parth (V1 rule) | The rack rule currently runs on correction days only | Per-location pick time: item_activity picking lines (`location_details`, `completion_time`) + an "ideal PPI" definition from Parth | 2–3 h |
| **Parth's PPI calibration** | Parth | Our PPI = picking-activity seconds ÷ units; his may differ | Compare 3 stores side by side | 15 min with Parth |
| **Audit quality rule sign-off** | Parth | Ours: ≥80% SKUs processed and ≥3 s per SKU. His: BELOW / MEETS PROVISIONAL_SOP | Parth's definition | 15 min |
| **SM item outcomes (found / not found)** from C's `Recovery_Action` | Vision (evidence) | Per-item "why not found" is lost | Read C's Recovery_Action tab (sheet `1_JdCO5…`) as an input | 1 h |
| **Complaints per captain** (missing / wrong item) | Vision (accuracy) | Parth's roster had them; ours doesn't, so accuracy = audit quality only | Complaint table name (storeops.order_complaint_v2 exists) | 1–2 h |
| **Item audits (ITEM_AUDIT_V2, Business Request)** | Parth | His high-value item audits aren't counted as work | Decide whether they count toward captain hours | 30 min |
| **Pilferage by L0 / MRP** | Vision | Uses keywords + ₹ per unit today | Add l0 / mrp to RAWItemlevel_north (rpc tables already joined) | 30 min |
| **HHD: create the location audits automatically** | Vision | SM still creates audits on the HHD by hand from the printed sheet | A StoreOps API (not available) | Out of scope |
| **Rahul's SOP** | Vision | Printed "How" steps are a draft | Rahul edits the SOP tab | Rahul, 30 min |
| **All North stores** | Rollout | Queries and STORE_MASTER hold our 51 (UP West + Uttarakhand) | The North outlet list, with region, cluster and CM per store | You |
| **Charter goodness: wastage, complaints, forward / reverse** (the UK SM dashboard on branch `claude/eager-faraday-yy1kj1`) | Your charter | Not part of recovery; its queries are placeholders | Real table names; merge as extra tabs later | Separate project |

---

## Part 2. Go live for all North stores in 2 hours
**Who:** Claude in Chrome does the clicks with `HANDOFF_CHROME_FINAL.md` (card 1 on the copy page). You approve, and supply the 3 lists in Part 3.

| Time | Step | Who | Done when |
|---|---|---|---|
| **0:00–0:05** | Answer the 4 questions (regions, access, state names, high-value) | **You** | Answers sent |
| 0:00–0:15 | Apps Script: replace **Code, Engine, Service, App** from the copy page → save → menu **1. Set up / repair tabs** (approve "connect to external service") | Chrome; you approve | END lines OK; SYNC tab has 10 rows |
| 0:15–0:50 | Redash: create the **10 queries** on [Warehouse] Trino. They pick the North stores themselves. Run, check rows, save as `RE · …`, note the ids | Chrome | 10 query ids; checks noted |
| 0:50–1:00 | CFG `inputs_sheet_id` = `1csiQryJ…` → Set up again → menu **Connect Redash** (you paste your Redash API key) → put the 10 ids in SYNC → **Sync data from Redash now** | Chrome; **you paste the key** | Every SYNC row OK |
| 1:00–1:15 | Check STORE_MASTER and USERS_AUTO were synced (stores per region, SM / CM counts). Add Parth and Rahul to USERS as PM | Chrome | HEALTH: required rows OK |
| 1:15–1:30 | Menu **Refresh all stores now** → **3. Turn on hourly refresh + monitoring** → **Send a test alert** | Chrome | JOB_RUNS OK; 6 triggers; email received |
| 1:30–1:40 | Check one AT_RISK store: crew chips with real names "On floor · HH:MM", Racks with most variance | Chrome | Done criterion 1 met |
| 1:40–1:50 | **Deploy → New deployment → Web app** (Execute as Me, anyone in org) | **You approve** | Web app URL |
| 1:50–2:00 | Smoke test: you (Control tower, Monitoring), 1 SM (own store only; Do first → Confirm → PDF), 1 CM (own stores only). Then share the URL + `TRAINING.md` SM one-pager with CMs | You + 1 SM + 1 CM | All green |

**If the Redash sync fails with DNS / "Address unavailable":** Google's servers can't reach Redash. Then, for today:
1. Download each query's result as CSV and use File → Import → Replace current sheet into its tab (about 10 min).
2. Ask IT to allow Google Apps Script to reach redash-queries.grofer.io (or use the same sync the C sheet uses) so the hourly sync works from tomorrow.

Until then, "on the floor now" is right only for about 90 minutes after each import.

---

## Part 3. What I still need from you
**Blocking (next 2 hours):**
1. **Answers to the 4 questions in chat:**
   - live regions;
   - who gets automatic access;
   - state names;
   - the high-value rule.
2. **Approvals during the run:**
   - the Google permission screen ("connect to an external service");
   - **typing your Redash API key** into "Connect Redash";
   - the Deploy click;
   - asking 1 SM and 1 CM to open the link.

**Needed this week (not blocking):**

3. **Parth:**
   - TFR / R2A / surge source;
   - his eligible auditor IDs (paste into CFG `complex_approved_ids`);
   - sign-off on the audit quality rule and the severity ₹ lines;
   - a PPI comparison on 3 stores;
   - a side-by-side with his plan preview for 1 store.
4. **Rahul:** the ground SOP (SOP tab) and training slots.
5. **You:** low-order windows per store, if you want them shown (STORE_MASTER `low_order_window`).
