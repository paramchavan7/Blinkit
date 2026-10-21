# Recovery Engine: North rollout plan

Owner: **Param Chavan** (PM). Data and go-ahead: **Parth Saluja**. Training, SOP and ground feedback: **Rahul**. Daily review: **CMs**. Daily use: **SMs**.

## The decision this plan builds on
**Every North store gets access on day 0.** Daily planning becomes mandatory in two waves, so one bad day can't damage SM trust everywhere at once.
**Recommendation:** make the second wave mandatory only after Parth's go-ahead and that region's training.

## Timeline
| Day | What | Who | Done when |
|---|---|---|---|
| **Tue 21 Oct** | Code final, tested in an Apps Script simulator at 200 stores. Copy page, setup guide and Chrome handoff ready | Claude | ✅ |
| **Wed 22 Oct** AM | Setup (HANDOFF_CHROME.md, steps 1-6): sheets, code, CFG, queries, sync | Param + Claude in Chrome | HEALTH required rows OK; JOB_RUNS shows OK |
| Wed 22 PM | STORE_MASTER (North list), USERS (all SMs and CMs), deploy, hourly refresh on | Param; CMs send SM emails | Link works for 1 SM per region (smoke test) |
| Wed 22 18:00 | **All North stores live** (view and plan). CM briefing, 30 min | Rahul, Param | Every CM has opened Cluster review |
| **Thu 23 Oct** | **Parth demo** (PARTH_DEMO.md), 20 min on live data → go-ahead and data fixes | Param, Parth | Go-ahead + list of data fixes |
| Thu 23 | SM training, per region (TRAINING.md), 3 sessions × 45 min | Rahul + region CM | Attendance ≥ 90% of SMs |
| **Fri 24 Oct** | **Wave 1 mandatory**: the 10 pilot stores + UP West + Uttarakhand plan daily and close the shift | SMs, CMs | `plan_rate_pct` ≥ 60% in wave 1 |
| Mon 27 Oct | **Wave 2 mandatory**: the other North regions (`live_regions` blank = all) | CMs | Same targets per region |
| Mon 27 – Fri 31 | Daily 15-min standup: Monitoring + metrics, top 3 issues | Param, Rahul, CMs | Issues closed within 24 h |
| **Fri 31 Oct** | **Go / no-go** on the METRICS.md week-1 criteria; tune thresholds in CFG with Parth | Param, Parth, Rahul | Decision recorded |
| Week of 3 Nov | First efficiency read: ₹ per man-hour, and kept-suggestion vs changed plans | Param | One-page readout to leadership |

## Daily rhythm once live
- **Before 09:30:** daily queries refreshed (Redash schedules). The audit sessions refresh every hour.
- **10:00 to 11:00:** SM opens the app, checks the racks with most variance, confirms the crew (best auditors on the floor are pre-ticked), prints the captain sheets, and creates the location audits on HHD.
- **During the shift:** captains work their printed page. The app picks up audits within the hour.
- **End of shift:** SM closes the shift (actual hours, done / partial / not done).
- **11:30 and 18:30:** CM runs Cluster review. Flags NO_ACTUALS, LOW_EXECUTION, LOW_ADHERENCE, RELAPSED and NO_YIELD need a decision with an owner.
- **Every hour:** the refresh job runs. On failure, stale data or an error spike, it emails the alert list.

## Support
- **First line:** the region CM. **Second line:** Rahul (process) or Param (app).
- **Access requests:** CM adds the USERS row. It works immediately; no redeploy.
- **Bugs:** Monitoring → Errors (`[system]` rows). Param sends the exact text to the engine owner.
- **Rollback:** Deploy → Manage deployments → previous version (1 minute). For one region: remove it from `live_regions`.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Parth's queries are not forkable, or his store list can't be widened in time | Medium | Ask Wed AM. Backup: `LOCATION_RACKS_lite.sql`. The app works with only the 2 required queries; the roster and audits add the crew suggestion |
| The Redash → Sheets sync can't push 300k audit rows hourly | Medium | Shorten AUDIT_SESSIONS to today only (change `interval '1' day` to `'0'`). Keep it in the Inputs sheet |
| SMs on another email domain can't be identified (Execute as Me) | Low–medium | Test one SM per region on Wed. If it fails, switch the deployment to "Execute as user accessing" (tell the owner) |
| Presence is only as fresh as the hourly audit export | Certain | The UI says "audit data up to HH:MM". The SM always has the final say on the crew |
| Thresholds (severity ₹, broken rack/aisle) are provisional | Certain | Parth reviews on Thu; edit in CFG with no redeploy |
| Sheet growth over months | Medium | Nightly archive (02:00); HEALTH shows the % of the 10M-cell limit and alerts above 80% |
