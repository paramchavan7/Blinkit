# Put Recovery Engine v2 into your "IRD V0.6" sheet: step by step

Time: about 20 minutes. You only copy and paste. Nothing in C (the Recovery App sheet) or in Parth's V2 sheet is changed.

You need the 4 files from the `recovery-engine` folder:

| File in this folder | Goes into the editor file called |
|---|---|
| `Code.gs` | **Code.gs** (already exists) |
| `IRD_Core.gs` | **IRD_Core.gs** (already exists) |
| `IRD_App.html` | **IRD_App.html** (already exists) |
| `IRD_Service.gs` | **IRD_Service.gs** (new; you add it in step 6) |

To copy a file from GitHub: open the file → click the **Copy raw file** icon (two overlapping squares, top-right of the code) → it is now on your clipboard.

---

## Part A: Back up (1 min)
1. Open the **IRD V0.6** Google Sheet.
2. **File → Make a copy** and name it `IRD V0.6 BACKUP`. If anything goes wrong, the old version is still there.

## Part B: Replace the code (5 min)
3. In the IRD V0.6 sheet: **Extensions → Apps Script**. You see the editor with Code.gs, IRD_Core.gs and IRD_App.html on the left.
4. Click **Code.gs** on the left. Click anywhere inside the code. Press **Ctrl+A** (Mac: Cmd+A), then **Delete**. Paste the new `Code.gs` (**Ctrl+V**). Press **Ctrl+S** to save.
5. Do exactly the same for **IRD_Core.gs** (paste the new `IRD_Core.gs`) and **IRD_App.html** (paste the new `IRD_App.html`). Save each one.
6. Add the new file: click the **+** next to "Files" → **Script** → type `IRD_Service` (no ".gs", the editor adds it) → press Enter. Delete the few lines it starts with, paste `IRD_Service.gs`, and save.
7. Check: the left side now shows 4 files: Code.gs, IRD_Core.gs, IRD_App.html, IRD_Service.gs.

## Part C: Run setup once (3 min)
8. At the top, next to **Run** and **Debug**, there is a dropdown that currently says `IRD_SETUP`. Click it and choose **RE_SETUP**.
9. Click **Run**. A box asks for permission: **Review permissions** → pick your grofers account → **Allow**.
   It asks for Drive access because the app now creates the printable captain sheets. That is expected.
10. Wait for "Execution completed" at the bottom. Go back to the sheet tab in your browser and **reload the page**.
11. A new menu appears at the top of the sheet: **Recovery Engine**. Setup has created these tabs:
    `CFG, USERS, SOP, HEALTH, PLANS, PLAN_TASKS, PLAN_ITEMS, ACTUALS, CM_REVIEWS, ACTION_LOG, DAILY`.
    The old V0.6 tabs (IRD_SETTINGS, IRD_PLANS …) are no longer used. Right-click each one → **Hide sheet**.

## Part D: Fill in the settings (5 min)
Open the **CFG** tab. Column A is the setting, column B is **your value** (blank = use the default in column C), and column D explains it.

| Setting (column A) | What to put in column B |
|---|---|
| `pilot_outlets` | `7184,6406,7877,6826,3432,7204,8468,8211,4823,7476` |
| `inputs_sheet_id` | The ID of Parth's **Instore Recovery Engine V2** sheet: the long code in its URL between `/d/` and `/edit`. The app then reads EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW, STORE_HEALTH_RAW and PILOT_COHORT directly from there, always fresh, with no pasting. |
| `cm_emails` | CM emails, separated by commas |
| `recovery_app_url` | The Recovery App (C) web link |
| `export_folder_id` | Optional: the ID of a Drive folder for the print sheets |

Everything else already has Parth's numbers (PPI 18 s, TFR 99.5%, R2A 30 s, surge 2%, the full-rack 25% / 50% rules, 4.7 min per location, 0.4 conversion). Change them here or in the app's **Settings & log** screen at any time.

**USERS tab** (who can do what). One row per person:

| email | role | outlet_ids |
|---|---|---|
| you@grofers.com | PM | *(blank = all)* |
| cm.name@grofers.com | CM | *(blank = all)* |
| sm.name@grofers.com | SM | 3432 |

Setup adds you as PM. While `restrict_sm_to_users` is FALSE, anyone in the company who is not listed is treated as an SM and can open any pilot store. Set it to TRUE once USERS is complete.

## Part E: Check the data (2 min)
12. Sheet menu: **Recovery Engine → Check data health**. The **HEALTH** tab opens with one row per input.
    Every row should say **OK**. EMPTY means a tab name is wrong (fix the `tab_…` setting in CFG). ERROR shows the reason in the "note" column.
13. **Recovery Engine → Turn on daily 10:00 job.** This takes the daily snapshots used for the T+3/T+7 results and the region ₹/hour benchmarks.

## Part F: Publish (2 min)
14. In the Apps Script editor: **Deploy → Manage deployments**.
15. Select your existing deployment, click the **pencil (edit)** icon → **Version: New version** → **Deploy**. The link stays the same, so SMs need nothing new.
    *No deployment yet?* **Deploy → New deployment** → gear icon → **Web app** → Execute as: **Me** → Who has access: **Anyone within Zomato** → **Deploy** → copy the link.
16. Open the link. Add `?store=3432` to the end to open a specific store.

## Where to see everything (your backend)
| You want to see | Look at |
|---|---|
| Who did what, when (plans, replans, actuals, CM decisions, settings changes, print sheets, daily job) | **ACTION_LOG** tab, or the app's **Settings & log** screen |
| Every plan | **PLANS** (one row per plan; `changes_vs_suggested` records what the SM changed, automatically) |
| Suggested vs planned per task and captain | **PLAN_TASKS** (`kind` S = suggested, P = planned) |
| Items being recovered, with their starting variance | **PLAN_ITEMS** |
| Actual hours and task status from the SM | **ACTUALS** |
| CM decisions | **CM_REVIEWS** |
| Daily store snapshots (pending ₹, severity, recovery mode) | **DAILY** |
| Whether the data feeding the app is complete and fresh | **HEALTH** (menu → Check data health) |
| Handheld steps printed for captains | **SOP**: edit the text, and the next print uses it |
| Every setting | **CFG**, or the app's Settings screen (PM only) |

## If something goes wrong
| You see | Do this |
|---|---|
| "run RE_SETUP once from the editor first" | Part C, step 8 |
| "cannot open the variance source sheet (C)" | You (the owner) need view access to C. `source_sheet_id` must be C's ID. |
| "tab "…" not found in the inputs sheet" | The tab name in Parth's sheet is different. Fix the matching `tab_…` setting in CFG. |
| "header row of PLANS was changed" | Someone edited row 1 of that tab. Put the header back (copy it from this guide's backup or run RE_SETUP on a copy). |
| The app shows old data after Parth's sheet refreshed | Menu → **Clear cached inputs** |
| A new version broke something | **Deploy → Manage deployments → pencil → Version:** pick the previous number → **Deploy**. This takes under a minute. |
