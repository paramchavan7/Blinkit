# Claude in Chrome: finish the Recovery Engine today (final instruction, 21 Oct 2026)

You are in Param Chavan's Chrome (param.chavan@grofers.com). This picks up from your install and your schema report.

**What exists now:**
- v3 is live on the /dev URL of the Grofers Apps Script project `1P3MoTV…`; it is not yet deployed.
- Setup has run, and the first refresh was OK: 51 stores, 28.3 s.
- The inputs are in the app sheet. The Inputs sheet is `1csiQryJr9_uJFLlh_qSzc-8Xu2ZUq6Wql-wzx3Ui0fo`.
- Redash is https://redash-queries.grofer.io, data source **[Warehouse] Trino**.

**Copy page (paste every file from here, with its Copy button only):** https://claude.ai/artifact/S5dMhYmry6sQ9pcJpwciVf

## Done when (all must be true; report each with its evidence)
1. Crew chips on at least one AT_RISK store show **real names with "On floor · HH:MM"**, and the suggested crew is ticked.
2. **Monitoring** shows:
   - Redash sync OK for the 10 tabs;
   - the last refresh OK in the last hour;
   - the triggers RE_REFRESH, RE_SYNC_HOURLY, RE_SYNC_DAILY and RE_MAINTAIN.
3. **"Racks with most variance"** is visible. **Do first → Confirm → Make printable sheet** works, and the PDF has one page per captain.
4. The **web app is deployed**: one SM sees only their store, and one CM sees only their stores.
5. The goodness-metrics table in the Control tower has today's row.

## Rules
- Paste code and SQL only from the copy page. Never edit code. If something fails, copy the exact error text and the file and line, then stop that step.
- **Param approves** every Google permission screen, the deploy, and sharing with anyone.
- **Redash API key:** copy it only into the app's "Connect Redash" prompt. Never put it in a report, a chat, a tab or a query.
- Redash: save the 10 queries below with their names. Never edit or fork anyone else's query.
- Check every ✔ before moving on.

---

## Step 1: Update the code (10 min)
The code changed after your install:
- App.html: the `<?` fix, same as yours;
- Service.gs: roster filter;
- Code.gs: built-in Redash sync, sync alerts, Monitoring shows the sync.

Engine.gs also changed: severity now works with PPI alone. Replace all 4 files.

1. In Apps Script, replace the content of **Code**, **Engine**, **Service** and **App** with the matching copy-page cards. Save each.
   - ✔ The four END lines are present.
   - ✔ Saving shows no SyntaxError.
2. In the sheet: **Recovery Engine → 1. Set up / repair tabs** (Param approves the new permission: "connect to an external service", which is for Redash).
   - ✔ A new **SYNC** tab exists, listing 10 tabs with an empty `redash_query_id`.

## Step 2: Create the 10 queries in Redash (30–40 min)
Every query now picks the North stores itself from Param's North city list (the `city_scope` / `north` / `scope` block at the top). Do not paste store IDs.
**Live regions:** in each query, the `scope` block's `where region in (...)` line lists the regions that are live. Keep all six unless Param says otherwise, and use the same list in all 10.

For each card: **New Query** → data source **[Warehouse] Trino** → paste → **Execute** → check → **Save** as the name below → write down the **id** (`/queries/<id>`).

| Card | Save as | Check on the result | SYNC row |
|---|---|---|---|
| `STORE_MASTER_north.sql` | RE · STORE_MASTER | One row per North store. Count the stores per region. Note the MISSING_CM / MISSING_SM counts | STORE_MASTER |
| `USERS_north.sql` | RE · USERS | One row per email, with role SM or CM. Count both | USERS_AUTO |
| `FLOOR_NOW_north.sql` | RE · FLOOR_NOW | Rows with `on_shift = 1` at many stores right now. No Store Managers | FLOOR_NOW (hourly) |
| `AUDIT_SESSIONS_north.sql` | RE · AUDIT_SESSIONS | Today's sessions. 7877 has > 50 by midday | AUDIT_EXECUTION_RAW (hourly) |
| `AUDITOR_DAILY_north.sql` | RE · AUDITOR_DAILY | The last 8 days, about 8–15 auditors per store per day | AUDITOR_DAILY |
| `ROSTER_north.sql` | RE · ROSTER | 30–80 rows per store, with names and designations filled | EMPLOYEE_CAPACITY_SYNC_RAW |
| `LOCATION_RACKS_north.sql` | RE · LOCATION_RACKS | 150–400 rows per store | LOCATION_RECOVERY_RAW |
| `RAWItemlevel_north.sql` | RE · RAWItemlevel | At most 200 rows per store. Some rows have `audit_decrement_qty` > 0 | RAWItemlevel |
| `STORE_VARIANCE_DAILY.sql` | RE · STORE_VARIANCE_DAILY | Stores × about 60–90 days | STORE_VARIANCE_DAILY |
| `STORE_HEALTH_north.sql` | RE · STORE_HEALTH | One row per store per day; `ppi` mostly 10–40 s | STORE_HEALTH_RAW |

- Write down each query's **runtime**. Anything over 3 minutes: add a Redash schedule (hourly for FLOOR_NOW and AUDIT_SESSIONS, daily 05:30 for the rest) and set that SYNC row's `max_age_minutes` to 90 (hourly) or 600 (daily), so the sync reads the stored result instead of waiting.
- If a query errors on a table name (`storeops_etls.user_store_role_mapping`, `ops_management.shift`, `ops_management.user`, `retail.console_location`), copy the exact error and continue with the others.

## Step 3: Connect the sheet to Redash (10 min)
1. App sheet **CFG**: `inputs_sheet_id` = `1csiQryJr9_uJFLlh_qSzc-8Xu2ZUq6Wql-wzx3Ui0fo` → **1. Set up / repair tabs**.
   - ✔ The Inputs sheet has the 10 blue tabs, including FLOOR_NOW.
2. Copy PILOT_COHORT from the app sheet to the Inputs sheet (same tab name, paste at A1). STORE_MASTER now comes from Redash.
3. **Param:** menu **Connect Redash (address + API key)**:
   - address `https://redash-queries.grofer.io`;
   - API key from Redash → profile → API Key. Param types it; you never handle the key.
4. **SYNC** tab: put each query id on its row. Keep `refresh` as set: hourly for FLOOR_NOW and AUDIT_EXECUTION_RAW, daily for the rest.
5. Menu **Sync data from Redash now**.
   - ✔ Every SYNC row is OK with a row count.
   - ✔ USERS_AUTO (app sheet) lists the SMs and CMs.
   - **"Redash HTTP 4xx":** re-run Connect Redash.
   - **DNS / "Address unavailable" / a login page:** Google can't reach Redash. Stop, report it, and use the fallback: download each result as CSV and use File → Import → Replace current sheet into its tab.

## Step 4: Refresh and check the SM view (10 min)
1. Menu **2. Check data health**.
   - ✔ The required rows are OK.
   - ✔ AUDIT_EXECUTION_RAW, AUDITOR_DAILY, EMPLOYEE_CAPACITY_SYNC_RAW and LOCATION_RECOVERY_RAW are OK.
   - STORE_HEALTH_RAW is OK with PPI only (TFR, R2A and surge stay blank: no source yet).
2. Menu **Refresh all stores now**.
   - ✔ JOB_RUNS's last row is OK (expect under 60 s).
3. Open the /dev URL. In **Today**, pick an AT_RISK store.
   - ✔ The crew list starts with real names and "On floor · HH:MM" chips.
   - ✔ The banner reads "N on the floor now · M audited today".
   - ✔ "Racks with most variance" lists racks with ₹.
   - **If the crew list is empty or every chip says "Not seen":** report the store id, the AUDITOR_DAILY row count for that store today, and the `designation` values from step 2.
4. Menu **3. Turn on hourly refresh + monitoring**, then **Send a test alert to me**.
   - ✔ Monitoring lists 6 triggers: RE_REFRESH, RE_SYNC_HOURLY, 3 × RE_SYNC_DAILY, RE_MAINTAIN.
   - ✔ Param receives the test email.

## Step 5: People, deploy and smoke test (20 min)
1. **People come from USERS_AUTO**, synced daily from the store role mapping:
   - SM / ASM / senior SM → their own stores;
   - CM / ops head / city admin → all their stores.

   The **USERS** tab is only for overrides and extras (Param, Parth and Rahul as PM). A typed row always wins.
2. **Deploy → New deployment → Web app**. Execute as **Me**; access **Anyone within the organisation**. Param approves. Copy the URL.
3. Smoke test on the deployed URL:
   - As Param: Control tower (with today's goodness-metrics row) → Monitoring (sync, refresh and triggers all green).
   - **One SM** (Param asks them): they see only their store.
     - Tap **Do first** on the top rack → **Confirm plan** → **Make printable sheet** → open the PDF (one page per captain).
     - ✔ PLANS, PLAN_TASKS and ACTION_LOG show the new rows.
     - "Your Google account could not be verified" → report the SM's email domain.
   - **One CM:** Cluster review shows only their stores.
4. With Param's OK, share these via each page's Share menu:
   - the copy page;
   - the rollout page https://claude.ai/artifact/UaTimnUmDAgcf1z16Te8kD (plan, training, metrics, Parth demo);
   - the web app URL.

   Share with Parth and Rahul.

## Report back (paste this filled in)
```
Code updated (Code/Service/App END lines ok):
Redash query ids: STORE_MASTER= USERS= FLOOR_NOW= AUDIT_SESSIONS= AUDITOR_DAILY= ROSTER= LOCATION_RACKS= RAWItemlevel= STORE_VARIANCE_DAILY= STORE_HEALTH=
Stores per region / users (SM, CM):
Query checks (rows, runtime, BELOW share, designation values):
SYNC statuses (tab: status, rows):
HEALTH (input: status):
Refresh: status / seconds / stores:
Crew chips on AT_RISK store <id>: <names + chips>
Triggers listed:
Web app URL:
SM test (store, ok/problem):  CM test (ok/problem):
Shared with:
Errors (step + exact text):
Still open (who / what):
```
