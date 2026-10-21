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
   - Redash sync OK for the 6 tabs;
   - the last refresh OK in the last hour;
   - the triggers RE_REFRESH, RE_SYNC_HOURLY, RE_SYNC_DAILY and RE_MAINTAIN.
3. **"Racks with most variance"** is visible. **Do first → Confirm → Make printable sheet** works, and the PDF has one page per captain.
4. The **web app is deployed**: one SM sees only their store, and one CM sees only their stores.
5. The goodness-metrics table in the Control tower has today's row.

## Rules
- Paste code and SQL only from the copy page. Never edit code. If something fails, copy the exact error text and the file and line, then stop that step.
- **Param approves** every Google permission screen, the deploy, and sharing with anyone.
- **Redash API key:** copy it only into the app's "Connect Redash" prompt. Never put it in a report, a chat, a tab or a query.
- Redash: save the 6 queries below with their names. Never edit or fork anyone else's query.
- Check every ✔ before moving on.

---

## Step 1: Update the code (10 min)
The code changed after your install:
- App.html: the `<?` fix, same as yours;
- Service.gs: roster filter;
- Code.gs: built-in Redash sync, sync alerts, Monitoring shows the sync.

Engine.gs did not change.

1. In Apps Script, replace the content of **Code**, **Service** and **App** with the matching copy-page cards. Save each.
   - ✔ The three END lines are present.
   - ✔ Saving shows no SyntaxError.
2. In the sheet: **Recovery Engine → 1. Set up / repair tabs** (Param approves the new permission: "connect to an external service", which is for Redash).
   - ✔ A new **SYNC** tab exists, listing 6 tabs with an empty `redash_query_id`.

## Step 2: Create the 6 queries in Redash (30–40 min)
For each card below:
1. **New Query** → data source **[Warehouse] Trino** → paste → **Execute**.
2. Check the result against the table. If the check fails, still save, and note it in the report.
3. **Save** with the given name.
4. Write down the **query id** (the number in the URL `/queries/<id>`).

| Copy-page card | Save as | Check on the result | Goes to tab |
|---|---|---|---|
| `AUDIT_SESSIONS_north.sql` | RE · AUDIT_SESSIONS | Rows for 7877 today > 100. Most sessions are 60–300 s. Note the share of `BELOW_PROVISIONAL_SOP` | AUDIT_EXECUTION_RAW |
| `AUDITOR_DAILY_north.sql` | RE · AUDITOR_DAILY | Today's rows include people with `sessions = 0` (pickers on the floor). For 7877, about 8–15 auditors on past days | AUDITOR_DAILY |
| `ROSTER_north.sql` | RE · ROSTER | 30–80 rows per store. **Write down the distinct `designation` values** | EMPLOYEE_CAPACITY_SYNC_RAW |
| `LOCATION_RACKS_north.sql` | RE · LOCATION_RACKS | 150–400 rows per store | LOCATION_RECOVERY_RAW |
| `RAWItemlevel_north.sql` | RE · RAWItemlevel | At most 200 rows per store. Some rows have `audit_decrement_qty` > 0 | RAWItemlevel |
| `STORE_VARIANCE_DAILY.sql` | RE · STORE_VARIANCE_DAILY | About 51 stores × 60–90 days | STORE_VARIANCE_DAILY |

- **A query that runs longer than 4 minutes** won't sync (the sync waits 4 minutes). Note it. For AUDIT_SESSIONS or AUDITOR_DAILY, also add a Redash schedule (every hour) so the sync reads a stored result.
- **Optional, faster syncs:** add Redash schedules. Hourly for AUDIT_SESSIONS and AUDITOR_DAILY; daily 07:30 for the other four.

## Step 3: Connect the sheet to Redash (10 min)
1. App sheet **CFG**: `inputs_sheet_id` = `1csiQryJr9_uJFLlh_qSzc-8Xu2ZUq6Wql-wzx3Ui0fo`. Then run **1. Set up / repair tabs**.
   - ✔ The Inputs sheet has the 9 blue tabs.
2. Copy the PILOT_COHORT and STORE_MASTER tabs from the app sheet into the Inputs sheet (select all → copy → paste at A1 of the same-named tab). From now on the app reads inputs only from the Inputs sheet.
   - If STORE_MASTER is empty: build the 51 rows from RE · RAWItemlevel (`outlet_id`, `outlet_name`, `city`). Set `region` from the city (Uttarakhand cities → `Uttarakhand`, the rest → `UP West`) and **ask Param to confirm the regions and fill `cm_sm`**.
3. Menu **Connect Redash (address + API key)**:
   - address `https://redash-queries.grofer.io`;
   - API key from Redash → profile (top right) → **API Key**. Param approves copying it.
4. **SYNC** tab: put each query id in `redash_query_id` on its tab's row. Keep `refresh` as set: hourly for the two audit tabs, daily for the rest.
5. Menu **Sync data from Redash now**.
   - ✔ Every SYNC row has status **OK** and a row count.
   - ✔ The Inputs sheet tabs hold the data.
   - **Error "Redash HTTP 4xx":** wrong key or address. Re-run Connect Redash.
   - **DNS / "Address unavailable" / a login page:** Google's servers can't reach your Redash. **Stop this step** and report it. Fallback for today: download each result as CSV and use File → Import → Replace current sheet into its tab. Presence will then only be right for about 90 minutes after each import.

## Step 4: Refresh and check the SM view (10 min)
1. Menu **2. Check data health**.
   - ✔ The required rows are OK.
   - ✔ AUDIT_EXECUTION_RAW, AUDITOR_DAILY, EMPLOYEE_CAPACITY_SYNC_RAW and LOCATION_RECOVERY_RAW are OK.
   - STORE_HEALTH_RAW shows **OFF**. That is expected: there is no PPI/TFR source yet.
2. Menu **Refresh all stores now**.
   - ✔ JOB_RUNS's last row is OK (expect under 60 s).
3. Open the /dev URL. In **Today**, pick an AT_RISK store.
   - ✔ The crew list starts with real names and "On floor · HH:MM" chips.
   - ✔ The banner reads "N on the floor now · M audited today".
   - ✔ "Racks with most variance" lists racks with ₹.
   - **If the crew list is empty or every chip says "Not seen":** report the store id, the AUDITOR_DAILY row count for that store today, and the `designation` values from step 2.
4. Menu **3. Turn on hourly refresh + monitoring**, then **Send a test alert to me**.
   - ✔ Monitoring lists the 4 triggers.
   - ✔ Param receives the test email.

## Step 5: People, deploy and smoke test (20 min)
1. **USERS** (app sheet): add the SM and CM rows Param gives you. An SM row has role `SM` and `outlet_ids` set to their store. A CM row has role `CM` and either `regions` (`UP West` / `Uttarakhand`) or `outlet_ids`.
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
Redash query ids: AUDIT_SESSIONS= AUDITOR_DAILY= ROSTER= LOCATION_RACKS= RAWItemlevel= STORE_VARIANCE_DAILY=
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
