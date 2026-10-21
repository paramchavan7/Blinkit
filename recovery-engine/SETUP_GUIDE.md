# Recovery Engine v3: set up for every North store (no coding needed)

Every file is on the **copy page**, each with a Copy button. Total time: about 90 minutes the first time, most of it in Redash.

| File | Where it goes |
|---|---|
| `Code.gs`, `Engine.gs`, `Service.gs` | Three **script** files in Apps Script (names exactly `Code`, `Engine`, `Service`) |
| `App.html` | One **HTML** file in Apps Script named exactly `App` |
| `NORTH_OUTLETS.sql` | Run once in Redash. Gives the North store list |
| `RAWItemlevel_north.sql` | Redash → tab **RAWItemlevel** (daily, before 10:00) |
| `STORE_VARIANCE_DAILY.sql` | Redash → tab **STORE_VARIANCE_DAILY** (daily) |
| `AUDIT_SESSIONS_north.sql` | Wraps Parth's audit query → tab **AUDIT_EXECUTION_RAW** (**hourly**) |
| `AUDITOR_DAILY_north.sql` | Wraps Parth's audit query → tab **AUDITOR_DAILY** (hourly or daily) |
| `LOCATION_RACKS_north.sql` | Wraps Parth's location query → tab **LOCATION_RECOVERY_RAW** (daily). Backup: `LOCATION_RACKS_lite.sql` |
| Parth's `STORE_HEALTH_RAW` and `EMPLOYEE_CAPACITY_SYNC_RAW` | Forked, with the North store list → tabs with the same names (daily) |
| `STORE_MASTER.tsv`, `PILOT_COHORT.tsv`, `USERS.tsv` | Paste into cell A1 of those tabs |

---

## Part 1: Two sheets (5 min)
At North scale the input data is large (the audit sessions alone can reach 300,000 rows), and a Google Sheet holds 10 million cells. So the inputs live in their own sheet.
1. Create **Recovery Engine** (the app) and **Recovery Engine Inputs** (data only) at https://docs.google.com/spreadsheets/u/0/create.
2. Copy the Inputs sheet's ID from its address bar: the part between `/d/` and `/edit`.

## Part 2: Paste the code (10 min)
3. In **Recovery Engine**: **Extensions → Apps Script**. Rename the project **Recovery Engine**.
4. Click **Code.gs** → Cmd+A → Delete → paste card **Code.gs** → Cmd+S.
5. **+ → Script** → name it `Engine` → paste card **Engine.gs** → Cmd+S. Then **+ → Script** → `Service` → paste **Service.gs** → Cmd+S.
6. **+ → HTML** → name it `App` → paste **App.html** → Cmd+S.
7. **Check every file:** press Cmd+↓ in each. The last line of the three scripts reads `// ===== END OF …`, and App ends with `</html>`. If one doesn't, its paste was cut off: empty it and paste again.
   - The project must contain only these 4 files. Delete any old IRD files: their `doGet` and other function names collide with the new ones.

## Part 3: Build the backend (5 min)
8. Reload the **Recovery Engine** sheet → menu **Recovery Engine → 1. Set up / repair tabs** → Continue → your account → **Allow**. If you see "Google hasn't verified this app", click Advanced → Go to Recovery Engine. Then click the menu item **once more**.
9. **CFG** tab, column B:
   - `inputs_sheet_id` = the Inputs sheet ID from step 2
   - `alert_emails` = who gets monitoring emails (blank = `pm_emails`)
10. Run **1. Set up / repair tabs** again. The blue input tabs are now created **in the Inputs sheet**.

## Part 4: Data (60 min, once)
11. **North list:** run `NORTH_OUTLETS.sql`, keep the North stores, and copy their outlet IDs.
    - In `RAWItemlevel_north.sql` and `STORE_VARIANCE_DAILY.sql`, paste the IDs (comma separated) into the `scope` block at the top. That block is the only part you edit.
12. **STORE_MASTER** (Inputs sheet): one row per live store, with `outlet_id, outlet_name, city, region, cluster, cm_sm, low_order_window`. **This tab decides which stores are live.** The pilot rows are on the copy page.
13. **Parth's queries:** ask Parth for the Redash links to STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, AUDIT_EXECUTION_RAW and LOCATION_RECOVERY_RAW. For each one, **⋮ → Fork**. In the fork, Cmd+F for `7184` (his store list) and replace that list with the North IDs.
    - STORE_HEALTH_RAW and EMPLOYEE_CAPACITY_SYNC_RAW forks → tabs with the same names.
    - Make 3 new queries from `AUDIT_SESSIONS_north.sql`, `AUDITOR_DAILY_north.sql` and `LOCATION_RACKS_north.sql`. In each, paste the **whole SQL of your forked Parth query** between the `>>> PASTE` and `<<< PASTE` lines, delete `SELECT 1`, and remove any `;` at the end.
14. **Send every query to its tab in the Inputs sheet**, in replace mode. Use the same sync Parth's V2 sheet uses (check how his RAW tabs refresh and do the same).
    - Schedules: **AUDIT_EXECUTION_RAW hourly** (it powers "on the floor now"); AUDITOR_DAILY hourly or daily; everything else daily by 09:30.
15. **PILOT_COHORT** (Inputs sheet): paste the ready table at A1.
16. Menu **2. Check data health** → HEALTH tab. Both required rows must say **OK**; optional rows say OK or OFF.

## Part 5: People (15 min)
17. **USERS** tab (app sheet), one row per person (template on the copy page):
    - **SM:** `email`, `role` = SM, `outlet_ids` = their store
    - **CM:** role CM, plus either `regions` (e.g. `UP West, Uttarakhand`, matching STORE_MASTER region or cluster) or `outlet_ids`
    - **PM:** role PM (sees everything)

    `restrict_sm_to_users` is TRUE by default, so anyone not listed is told to ask their CM. Rows are added live; no redeploy is needed.

## Part 6: Switch on (10 min)
18. Apps Script: **Deploy → New deployment → ⚙ → Web app**. Execute as **Me**; access **Anyone within your organisation** → **Deploy** → copy the **Web app URL**. That link is the app for everyone.
19. Sheet menu **Refresh all stores now**. This fills STORE_STATE, PLAN_RESULTS and METRICS_DAILY, and JOB_RUNS shows OK with the seconds it took.
20. Menu **3. Turn on hourly refresh + monitoring**, then **Send a test alert to me**.
21. **Smoke test:**
    1. Open the URL: you land on the Control tower.
    2. Open the Monitoring tab: the last good refresh is shown and the triggers are listed.
    3. Ask **one SM** to open the link. They should see only their store.
       - "Your Google account could not be verified" means their email domain is outside your Workspace: tell the owner.
    4. With the SM: tick the crew, tap **Do first** on a rack, then **Confirm plan** → **Make printable sheet** → check the PDF.

**Rolling out region by region:** CFG `live_regions` = `UP West, Uttarakhand` turns only those regions on (blank = every store in STORE_MASTER).

---

## When I send you new code
1. In Apps Script, replace the content of each file I name (Cmd+A, Delete, paste, Cmd+S), then check its END line.
2. **Deploy → Manage deployments → ✎ → Version: New version → Deploy.** The link stays the same.
3. Menu **1. Set up / repair tabs**. It is safe any time: it never deletes data, and it keeps old-format tabs as `NAME_old_<date>`.

## Where everything shows up
| You want | Look at |
|---|---|
| Is it running, is data fresh, who uses it, what failed | App → **Monitoring** (PM), or the **JOB_RUNS**, **HEALTH** and **ACTION_LOG** tabs |
| Goodness metrics per day, region and cohort | App → Control tower, or the **METRICS_DAILY** tab (definitions: `METRICS.md`) |
| Every plan, and what the SM changed vs the suggestion | **PLANS** (`changes_vs_suggested`, `pinned`), **PLAN_TASKS** (S = suggested, P = planned) |
| Results per plan (S/P/A hours, audited locations, ₹, T+3 / T+7) | **PLAN_RESULTS** |
| Settings | **CFG**, or app → Settings & log (every change is logged) |
| Old log rows | The **Recovery Engine Archive** sheet (moved nightly at 02:00) |

## If something goes wrong
| You see | Do this |
|---|---|
| `SyntaxError … line N, file "X"` on save or deploy | File X was cut off when pasted. Empty it, paste again, and check the END line |
| No Recovery Engine menu | Reload the sheet and wait 10 s; check all 4 files saved (no orange dot) |
| "tab … is missing" or "header row … was changed" | Menu → 1. Set up / repair tabs |
| HEALTH: EMPTY on a required row | The query result went to another tab, or to the app sheet instead of the Inputs sheet |
| An email: "Variance feed not refreshed today" | The RAWItemlevel schedule didn't run: rerun it in Redash |
| An email: "Audit sessions are stale" | The hourly AUDIT_EXECUTION_RAW schedule stopped. "On the floor now" is out of date until it runs |
| An email: "Refresh failed" or "did not finish" | Read JOB_RUNS. Over 5 minutes per run → tell the owner (the audit window may need shortening) |
| A new version broke something | Deploy → Manage deployments → ✎ → pick the previous version → Deploy (under a minute) |
