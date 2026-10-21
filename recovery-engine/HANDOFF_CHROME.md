# Handoff for Claude in Chrome: put the Recovery Engine live for every North store

You are operating Param Chavan's Chrome (signed in as param.chavan@grofers.com). The code is **finished and tested**: unit tests, an Apps Script simulator, and a 200-store scale run. Your job is to **set it up in the browser**, not to write code.

## Rules
1. **Never edit code.** Paste files only from the copy page with its **Copy** buttons: https://claude.ai/artifact/S5dMhYmry6sQ9pcJpwciVf . If anything fails, stop and report the exact red error text, the file and the line.
2. **Stop and ask Param** for: Google permission screens ("Allow", "Advanced → Go to …"), anything that shares data outside the company, and any choice not written here.
3. **Verify each checkpoint (✔) before moving on.** At the end, report every ✔ with its evidence.
4. **Don't touch Parth's originals.** Fork his queries; never edit them.
5. Use `SETUP_GUIDE.md` (on the copy page / in the repo) for click-level detail. This file is the order of work and the checks.

## What you need from Param before starting
- [ ] The **North outlet list** (or permission to build it from `NORTH_OUTLETS.sql` with him).
- [ ] **Redash links** to Parth's 4 queries: STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, AUDIT_EXECUTION_RAW, LOCATION_RECOVERY_RAW.
- [ ] **SM and CM emails** with their store IDs / regions (for USERS).
- [ ] How Parth's V2 sheet gets its query data (the sync method), so you can repeat it.

---

## Step 1: Sheets and code (≈15 min)
1. Create the Google Sheets **Recovery Engine** and **Recovery Engine Inputs**. Note both URLs and the Inputs sheet ID.
2. In Recovery Engine: Extensions → Apps Script. Create exactly 4 files and paste the matching copy-page card into each:
   - script `Code`
   - script `Engine`
   - script `Service`
   - HTML `App`

   Save each one.
   - ✔ The last line of Code, Engine and Service is `// ===== END OF <name>.gs …`, and App ends with `</html>`.
   - ✔ There are no other files in the project.
   - ✔ Saving shows no SyntaxError.

## Step 2: Backend (≈5 min)
3. Reload the sheet → **Recovery Engine → 1. Set up / repair tabs** (Param approves the permission screen) → run it once more.
4. CFG column B:
   - `inputs_sheet_id` = Inputs ID
   - `alert_emails` = param.chavan@grofers.com (plus anyone Param names)

   Run **1. Set up** again.
   - ✔ The Inputs sheet now has 9 blue tabs: RAWItemlevel, STORE_VARIANCE_DAILY, STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW, AUDITOR_DAILY.
   - ✔ The app sheet has CFG, USERS (Param as PM), SOP, HEALTH, PLANS, PLAN_TASKS, PLAN_ITEMS, ACTUALS, CM_REVIEWS, ACTION_LOG, DAILY, STORE_STATE, PLAN_RESULTS, METRICS_DAILY, JOB_RUNS, START_HERE.

## Step 3: Queries in Redash (≈45 min)
5. Run `NORTH_OUTLETS.sql`; with Param, keep the North stores. Paste their IDs into the `scope` block of `RAWItemlevel_north.sql` and `STORE_VARIANCE_DAILY.sql`. Save both as new Redash queries.
6. Fork Parth's 4 queries (**⋮ → Fork**). In each fork, Cmd+F `7184` and replace his store list with the North IDs. Save.
7. Create 3 queries from `AUDIT_SESSIONS_north.sql`, `AUDITOR_DAILY_north.sql` and `LOCATION_RACKS_north.sql`. Paste the full SQL of the matching fork between the `>>> PASTE` / `<<< PASTE` markers:
   - the AUDIT fork for the first two;
   - the LOCATION fork for the third.

   Delete the `SELECT 1` placeholder and any trailing `;`. Run each one.
   - ✔ Each query returns rows, and its columns match the header row of its tab.
   - ✔ AUDIT_SESSIONS holds only today and yesterday.
   - ✔ LOCATION_RACKS has about 200–300 rows per store.
8. Schedules (where to send each result, in replace mode, into the **Inputs** sheet):

| Redash query | Tab | Refresh |
|---|---|---|
| RAWItemlevel_north | RAWItemlevel | daily 08:00 |
| STORE_VARIANCE_DAILY | STORE_VARIANCE_DAILY | daily 08:00 |
| Parth STORE_HEALTH_RAW (fork) | STORE_HEALTH_RAW | daily 08:30 |
| Parth EMPLOYEE_CAPACITY_SYNC_RAW (fork) | EMPLOYEE_CAPACITY_SYNC_RAW | daily 08:30 |
| LOCATION_RACKS_north | LOCATION_RECOVERY_RAW | daily 08:30 |
| AUDITOR_DAILY_north | AUDITOR_DAILY | hourly |
| AUDIT_SESSIONS_north | AUDIT_EXECUTION_RAW | **hourly** |

   - ✔ After the first sync each tab has data under a header row (names in row 1).
   - If the sync can't handle AUDIT_SESSIONS' size: change `interval '1' day` to `interval '0' day` (today only) and note it in the report.

## Step 4: Stores and people (≈15 min)
9. **STORE_MASTER** (Inputs): paste the North list with `outlet_id, outlet_name, city, region, cluster, cm_sm, low_order_window`. Use the region names that CMs will be scoped by. **PILOT_COHORT** (Inputs): paste the card.
10. **USERS** (app sheet): one row per SM (`SM`, outlet_ids), CM (`CM`, regions or outlet_ids) and PM. The template is on the copy page.
11. Menu **2. Check data health**.
   - ✔ HEALTH: both required rows OK.
   - ✔ The optional rows say OK (or OFF, only for inputs Param chose to skip).
   - ✔ "Spreadsheet size" under 60% for both sheets.

## Step 5: Switch on (≈10 min)
12. Menu **Refresh all stores now**.
   - ✔ JOB_RUNS's last row is OK, with seconds (expect under 120).
   - ✔ STORE_STATE has one row per North store.
13. Menu **3. Turn on hourly refresh + monitoring**, then **Send a test alert to me**.
   - ✔ Param receives the email.
14. Apps Script → **Deploy → New deployment → Web app**. Execute as **Me**; access **Anyone within the organisation**. Param approves.
   - ✔ The Web app URL is copied.

## Step 6: Smoke test (≈10 min)
15. Open the URL as Param.
   - ✔ The Control tower lists every region.
   - ✔ The Monitoring tab shows the last good refresh and the triggers RE_REFRESH and RE_MAINTAIN.
   - ✔ The Today tab for a broken store shows "Racks with most variance" and crew chips ("On floor · HH:MM").
16. Ask Param to have **one SM per region** open the URL.
   - ✔ Each sees only their store.
   - ✔ No "account could not be verified" message. If it appears, report the SM's email domain.
17. With one SM: tap **Do first** on a rack → **Confirm plan** → **Make printable sheet** → open the PDF.
   - ✔ There is one page per captain.
   - ✔ PLANS and ACTION_LOG show the new rows.

## Report back to Param (paste this filled in)
```
App URL:
App sheet URL:            Inputs sheet URL:
Stores live (STORE_STATE rows):
First refresh: status / seconds:
HEALTH: <input: status> for each row
Redash queries and schedules created: <names>
Changes from the plan (e.g. audit window today-only):
SM smoke tests: <store: ok / problem>
Errors seen (exact text):
Still open (who / what):
```

## If something fails
| Symptom | Action |
|---|---|
| `SyntaxError … file "X"` | Re-paste file X from the copy page and check the END line. Still failing → report it |
| "tab … is missing" / "header row … was changed" | Menu 1. Set up / repair tabs |
| HEALTH says EMPTY or ERROR | Check the sync target: the right tab name, in the **Inputs** sheet, with a header row |
| JOB_RUNS FAILED | Copy the `detail` text into the report. Don't retry more than twice |
| Anything else unexpected | Stop. Report what you clicked, what you saw, and the exact text |
