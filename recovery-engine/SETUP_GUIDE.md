# Recovery Engine: setup from zero (no coding needed)

You need **4 files**, sent to you with this guide:

| File | What it is |
|---|---|
| `Code.gs` | All the backend. You paste it into Apps Script once. |
| `App.html` | The app screen. You paste it into Apps Script once. |
| `RAWItemlevel_basic.sql` | Query 2. Its result goes into the **RAWItemlevel** tab. |
| `STORE_VARIANCE_DAILY.sql` | Query 1. Its result goes into the **STORE_VARIANCE_DAILY** tab. |

Total time: about 25 minutes the first time.

---

## Part 1: Make the sheet (2 min)
1. Open **https://docs.google.com/spreadsheets/u/0/create** using your work account.
2. Click "Untitled spreadsheet" (top left) and name it **Recovery Engine**.

## Part 2: Paste the code (5 min)
3. In that sheet: **Extensions → Apps Script**. A new tab opens with a file called **Code.gs** that contains `function myFunction() { }`.
4. Click "Untitled project" (top left) and rename it **Recovery Engine**.
5. Click inside the code area. Press **Ctrl+A** (Mac: Cmd+A), then **Delete**. The area is now empty.
6. Open the `Code.gs` file I sent. Press **Ctrl+A**, **Ctrl+C**, go back to Apps Script, and press **Ctrl+V**. Then **Ctrl+S** to save.
7. On the left, next to "Files", click **+** → **HTML**. Type **App** (capital A, nothing else) and press Enter.
8. In the new App.html, press **Ctrl+A** → **Delete**. Paste the whole `App.html` file I sent. Press **Ctrl+S**.
   You should now see two files on the left: **Code.gs** and **App.html**.

## Part 3: Let the script build the backend (2 min)
9. Go back to the **sheet** tab and **reload the page** (F5). Wait about 10 seconds. A new menu, **Recovery Engine**, appears at the top, after "Help".
10. Click **Recovery Engine → 1. Set up / repair tabs**.
    - The first time, Google asks for permission: **Continue** → choose your work account → **Allow**.
      If you see "Google hasn't verified this app": click **Advanced** → **Go to Recovery Engine**. It is your own script.
    - After allowing, **click the menu item once more**. The first click only grants permission.
11. A message says it is set up, and the **START_HERE** tab opens. Setup has created:
    - **Blue tabs** (inputs you fill): RAWItemlevel, STORE_VARIANCE_DAILY, STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW
    - **Green tabs** (the app's backend): CFG, USERS, SOP, HEALTH, PLANS, PLAN_TASKS, PLAN_ITEMS, ACTUALS, CM_REVIEWS, ACTION_LOG, DAILY

## Part 4: Put the data in (10 min the first time)
12. Run **`RAWItemlevel_basic.sql`** in your query tool. Get the result into the **RAWItemlevel** tab in either of two ways:
    - **Sync (best):** point your query tool's Google Sheets sync at this sheet, tab **RAWItemlevel**, mode "replace". Then it refreshes by itself.
    - **By hand:** download the result as CSV. In the sheet, click the **RAWItemlevel** tab → **File → Import → Upload** → pick the CSV → Import location **"Replace current sheet"** → **Import data**.
13. Do the same with **`STORE_VARIANCE_DAILY.sql`** → tab **STORE_VARIANCE_DAILY**.
14. *(Optional, unlocks more features: see START_HERE for which feature each tab unlocks.)* Paste the exports you already have into the other blue tabs with the same names, e.g. EMPLOYEE_CAPACITY_SYNC_RAW, AUDIT_EXECUTION_RAW. Column order does not matter.
15. Click **Recovery Engine → 2. Check data health**. The HEALTH tab opens. Both **required** rows must say **OK**.

## Part 5: People and settings (3 min)
16. **USERS** tab: your email is already there as PM. Add one row per person: `email`, `role` (SM, CM or PM), and for SMs `outlet_ids` (e.g. `7076`).
17. **CFG** tab: column B is your value; leave it blank to use the default in column C. Set at least:
    - `pilot_outlets` → the store IDs to show, e.g. `7076,7978,6826`. Blank = every store in RAWItemlevel.
    - Every threshold (severity, broken rack and aisle, hours) already has Parth's numbers. You can change them here or in the app's Settings screen, and each change is logged.

## Part 6: Publish the app (3 min)
18. In the **Apps Script** tab: blue **Deploy** button (top right) → **New deployment** → click the gear next to "Select type" → **Web app**.
    - Description: `v1`
    - Execute as: **Me**
    - Who has access: **Anyone within [your organisation]**
    - Click **Deploy** (allow access again if asked) and **copy the Web app URL**. That link is the app.
19. Open the link. To open one store directly, add `?store=7076` to the end.
20. Back in the sheet: **Recovery Engine → 3. Turn on daily 10:00 job**. This keeps the before/after numbers the results screens use.

---

## When I send you an updated Code.gs or App.html
1. Apps Script → click the file → **Ctrl+A** → **Delete** → paste the new one → **Ctrl+S**.
2. **Deploy → Manage deployments** → pencil icon → Version: **New version** → **Deploy**. The link stays the same.
3. In the sheet: **Recovery Engine → 1. Set up / repair tabs** (safe to run any time; it never deletes data).

## Where everything shows up
| You want | Look at |
|---|---|
| Who did what, when | **ACTION_LOG** tab, or the app's Settings & log screen |
| Every plan, and what the SM changed vs the suggestion | **PLANS** (`changes_vs_suggested`) |
| Suggested vs planned, per task and captain | **PLAN_TASKS** (`kind` S = suggested, P = planned) |
| Actual hours logged by SMs | **ACTUALS** |
| CM decisions | **CM_REVIEWS** |
| Is my data complete and fresh? | **HEALTH** (menu → Check data health) |
| Printed captain steps | **SOP**: edit the text, and the next print uses it |
| Settings | **CFG** |

## If something goes wrong
| You see | Do this |
|---|---|
| No "Recovery Engine" menu | Reload the sheet and wait 10 seconds. Check that Code.gs was saved (no orange dot on the file name). |
| "tab RAWItemlevel is missing" | Menu → 1. Set up / repair tabs |
| HEALTH says EMPTY for a required tab | The query result was not pasted into that tab, or it went into a tab with a different name |
| "is missing column(s): …" | Your query output is missing that column. Check the header row of the tab. |
| The app shows old numbers after a refresh | Menu → Clear cached inputs |
| A new version broke something | Deploy → Manage deployments → pencil → pick the previous version → Deploy (under a minute) |
