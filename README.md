# UK SM Worklist dashboard

`generate_uk_sm_dashboard.py` builds one self-contained HTML file, `Dashboard - UK SM Worklist.html`, for Store Managers and CMs of the 48 Uttarakhand (UK) stores (Dehradun ++ 28, Haridwar ++ 20).

The file opens offline by double-click and can be sent as one attachment. ECharts is inlined and the page uses the system font stack. It is readable on a phone, and the store view prints.

An SM picks their store and sees the worklist for each charter: item, location, quantity, rupees, what to do, and who. A CM sees the store list grouped by CM and sorted by exception, with each store's worklist one click down.

## Status

| Part | State |
|---|---|
| Script, page, data control checks, CSV mode | Built and tested on SAMPLE data (`tests/`, 21 tests) |
| Redash mode | Tested against a local mock of the Redash API only; not run against your Redash |
| Every SQL file in `queries/` | **UNVALIDATED**. None of your queries were in the repo, so all are new. Tables prefixed `replace_me.` are placeholders; column names are guesses |
| Store master | Not in the repo. Without it, names and CMs show as "missing from store master" |
| FNV risk dashboard reference | Not in the repo, and the Apps Script links are blocked from the build environment. Layout follows the written spec |

## Run

Requirements: Python 3.10+, `pandas`, and `requests` (Redash mode only).

```bash
# 1. Sample data (generated, labelled SAMPLE on the page)
python3 make_sample_data.py                      # writes sample_data/ including a sample stores.csv
python3 generate_uk_sm_dashboard.py --csv-dir sample_data --store-master sample_data/stores.csv

# 2. Sheet exports (Redash unavailable): one <charter_key>.csv per result set in a folder
python3 generate_uk_sm_dashboard.py --csv-dir exports/

# 3. Redash: reads the last stored result of each query in CONFIG QUERIES
export REDASH_URL=https://redash.example.internal
export REDASH_API_KEY=...                         # user API key; never put it in the script
python3 generate_uk_sm_dashboard.py
python3 generate_uk_sm_dashboard.py --refresh     # ask Redash to re-run instead of using the stored result
```

Options: `--out PATH`, `--store-master PATH`, `--report-date YYYY-MM-DD` (window end, default yesterday IST), `--json-out PATH` (computed numbers, for checking).

The script prints each source's status and the control checks. It exits with code 0 when all checks pass and 2 when any fail. The HTML is written either way, and failing checks are listed on the page.

The store master is read from `--store-master`. Without that flag, the script looks for `stores.csv` or `store-master.md` in the current folder, then next to the script.

- **Columns:** `outlet_id`, `store name`, `cm`, `go live date`, `type`, `mode`. Common header spellings are accepted.
- **Format:** a CSV, or the first table in a Markdown file.
- **Matching:** stores are matched on `outlet_id` only.
- **No CM:** a blank CM shows as "CM unassigned".

## The page

- **Header.** Store selector grouped by CM (store name, outlet_id), CM, cluster, go-live with age, exact data pull time (oldest to newest source), and the window.
- **Data control strip.** One line: "All checks passing" or "N failing". The button lists each check and a sources table (status, retrieved_at, age, stale or not, rows).
- **CM view.** Stores grouped by CM, sorted by exception. Shows total and the four heads per order with state and direction, a 30-day total sparkline, open variance per order, complaints D-1 and the top exception. Every figure links to the store's tab.
- **Store summary**, above the tabs:
  - Total loss per order against 8.0, and the four heads against 3.5, 1.5, 1.5 and 1.5. Each shows rupees, the denominator, a sparkline, and trailing and baseline levels.
  - The second-source comparison, when it is loaded.
  - Fresh (FNV, Milk) as its own line, outside the total.
  - Forward in transit, and forward minus in transit.
  - CRWI as a separate line.
  - The arithmetic identity.
  - The head breakdown, with each component marked confirmed or inferred.
  - The trend parameters, labelled "heuristic, uncalibrated".
  - Incidents.
- **Tabs:**
  - **Variance (first):** open variance by item with the discriminator, pending audits, and auditor quality.
  - **Wastage and expiry:** closure against 95%, dump marking against 60%, dump value and percent of sales (non-fresh, FNV, Milk), open tasks, and near expiry.
  - **Complaints:** D-1 complaint percent against 1.5%, a daily chart, types, FNV QNG, and open complaints with age against the 4-hour RCI standard.
  - **Forward and transfer:** forward per order, unload versus putaway, GRN putaway pending, open consignments past 6h, DN short and damage, and crate attributable OpenDN with its two preconditions.
  - **Reverse:** reverse per order gross, CRWI, and open RSTO and RTS documents.
  - **Definitions.**
- **Export** saves the selected store's worklist (all tabs) as a CSV for WhatsApp. **Print** prints every tab of the store view.

### Store state

| State | Rule (loss metrics, higher is worse) | Shown as |
|---|---|---|
| BROKEN | level, rounded to 2 dp, at or above threshold | alert fill (the only use of the alert colour) and the label |
| DETERIORATING | below threshold, trailing at least `rise_pct` above baseline, trailing at least `min_share_of_threshold_pct` of threshold | dark fill and the label |
| CHRONIC | below threshold, trailing within `rise_pct` of baseline (stable), trailing and baseline both at least `min_share_of_threshold_pct` of threshold | light grey fill and the label |
| CLEAN | anything else | nothing |
| NO DATA | source missing, or the store absent from it | dashed outline and the label; never read as clean |

- **Level** is the MTD figure. Where the second source is loaded, the level is the higher of the two sources.
- **Direction** is a separate glyph: up, down, `-` (stable), or `?` (trend not computable because a day in the trailing or baseline window has no orders).
- **Trend** is trailing 3 days against the 14 days before them. Single events at or above `INCIDENT_MIN_RUPEES` are removed from the trend and listed as incidents.
- **Complaints** use D-1 as the level.
- **Floor metrics** (task closure, dump marking) are BROKEN when below the floor. They show no direction.

## CONFIG block

Everything you may change sits at the top of the script, between `CONFIG` and `END CONFIG`.

| Constant | Value | Source |
|---|---|---|
| `CLUSTERS` | the 48 outlet ids in two clusters | yours |
| `THRESHOLDS` | total 8.0, in-store 3.5, forward 1.5, reverse 1.5, returns and refunds 1.5, open variance 0.70, complaints 1.5%, closure floor 95%, dump marking floor 60%, auditor accuracy 100%, RCI 4h, consignment 6h | yours |
| `TREND` | trailing 3 days, baseline 14 days, rise 40%, minimum share 50% | yours (heuristic, uncalibrated) |
| `NEW_STORE_DAYS` | 60 | yours |
| `DENOMINATOR` | name, column, definition and source of the per-order denominator | definition **UNCONFIRMED**: set the one you are judged on |
| `INCIDENT_MIN_RUPEES` | 5000 | **author default, confirm**. `None` turns incident exclusion off |
| `MIN_AUDIT_SEC_PER_UNIT` | None | not given. When None, the line comes from the `min_audit_sec_per_unit` column if present; otherwise no line is drawn and no point is flagged |
| `CRATE_SCAN_ADHERENCE_MIN_PCT` | 99.0 | **author default** for "about 100 percent", confirm |
| `STALENESS_LIMIT_HOURS` | 6 | **author default, confirm**. Per-query override: `QUERIES[key]["stale_hours"]` |
| `QUERIES` | charter key to Redash `id`, `params`, `pending_access`, `stale_hours`, `columns` | ids not set yet |
| `HEADS` | component to head, sign, confirmed or inferred, in total formula or not | from your rules; all reverse components marked inferred |
| `REPORT_DATE` | None, which means yesterday IST | |
| `REDASH_MAX_AGE_SECONDS` | 7 days, so the last stored result is returned | |

`pending_access: True` means the source is not fetched. Its sections show greyed as "source pending access" and a control check fails. `reverse_open` starts that way, because `warehouse_etls.all_reverse_consignment_raw` is access denied. A Redash 403, or an error text containing "access denied" or "permission", is also treated as pending access. It is never silently dropped.

## Result sets

Each charter key is one result set: one Redash query, or one CSV in `--csv-dir`. Column names must match the list below. Use `QUERIES[key]["columns"]` to rename an existing query's columns instead of editing the query. The default renames the central sheet's `Total Wastage` column to `total_per_order`.

Every result set must contain every allowlist outlet:

- **List sets:** an outlet with nothing open returns one coverage row with the row key null. The queries do this by left-joining from the scope CTE.
- **Daily sets:** an outlet with no rows is reported as absent, never as clean.

| Key | Kind and grain | Columns |
|---|---|---|
| `loss_daily` | daily, outlet x IST day | outlet_id, dt, orders, gmv, bsd, bse, bsnte, manual_negative, manual_positive, bad_returns, lit, dn_other, nr, open_dn_short, refund, rsto_open_billed, rsto_open_dn_short, rsto_total_dump, esto, rts_short, crwi, fwd_in_transit, fnv_loss, milk_loss |
| `loss_events` | list, one row per single loss event | outlet_id, dt, event_id, head (in_store, forward, reverse, returns_refunds), component, ref_id, item_name, rupees |
| `loss_central` | optional, one row per outlet, MTD per order | outlet_id, total_per_order (`Total Wastage`), in_store_per_order, forward_per_order, reverse_per_order, returns_refunds_per_order |
| `variance_open` | list, outlet x item x negative location | outlet_id, item_id, item_name, is_fnv, open_qty, open_value, negative_location, probable_locations, last_auditor, last_audit_ts, first_negative_ts, nearby_long_qty, nearby_long_locations, inward_after_qty |
| `audit_pending` | list, one row per task | outlet_id, task_id, audit_type, item_id, item_name, location, assigned_to, created_ts, due_ts |
| `auditor_quality` | list, outlet x day x auditor | outlet_id, dt, auditor, units_touched, audit_seconds, inputs_total, inputs_correct, optional min_audit_sec_per_unit |
| `wastage_daily` | daily, outlet x IST day | outlet_id, dt, sales_total, sales_fnv, sales_milk, dump_total, dump_fnv, dump_milk, dump_lines_eligible, dump_lines_marked, nte_tasks_created, nte_tasks_closed, expiry_tasks_created, expiry_tasks_closed, negative_wastage_lines |
| `wastage_open_tasks` | list, one row per open task | outlet_id, task_id, task_type (NTE, EXPIRY), item_id, item_name, is_fnv, is_milk, location, qty, value, created_ts, assigned_to |
| `near_expiry` | list, outlet x item x location x expiry date | outlet_id, item_id, item_name, is_fnv, is_milk, location, qty, value, expiry_date |
| `complaints_daily` | daily, outlet x IST day | outlet_id, dt, orders, complaints, mdnd, item_missing, item_damaged, item_expired, wrong_item, qng, qng_fnv (all COUNT DISTINCT external_complaint_id) |
| `complaints_open` | list, one row per complaint | outlet_id, external_complaint_id, order_id, complaint_type, item_id, item_name, is_fnv, picker, created_ts |
| `forward_open` | list, one row per open consignment | outlet_id, consignment_id, source_name, status, priority, arrived_ts, units_expected, units_unloaded, units_putaway, grn_pending_units, value |
| `forward_dn` | list, outlet x consignment x item x DN type | outlet_id, dt, consignment_id, dn_type (SHORT, DAMAGE), item_id, item_name, is_fnv, qty, value |
| `forward_crates` | one row per outlet | outlet_id, scans_expected, scans_done, crate_attrib_open_dn_value, open_dn_value, crates_0_24h, crates_24_48h, crates_48_72h, crates_72h_plus |
| `reverse_open` | list, outlet x doc type x doc x state | outlet_id, doc_type (RSTO, RTS), doc_id, state (OPEN_BILLED, OPEN_DISPATCH, DN_SHORT), destination, qty, value, fnv_value, created_ts |

Format rules:

- **Timestamps** (`*_ts`) are IST. Ages are measured from the source's `retrieved_at` time, not from the moment the page is opened.
- **`retrieved_at`.** In CSV mode, add a `retrieved_at` column (ISO time, IST if it has no offset) to record when the export was pulled. Without it, the file's modified time is used and the page says so.
- **Flags** (`is_fnv`, `is_milk`) accept 1, 0, true, false, yes or no.

## How to add a query

1. Write the SQL in `queries/<charter_key>.sql` and follow the house rules:
   - one statement, no trailing semicolon, no inline comments;
   - scope through the `scope` CTE (`unnest(array[...])`) and never by city or business_type;
   - anchor windows on the IST date minus 1 day;
   - build the item dimension with `group by item_id` and `max_by`, never a self-join;
   - put join predicates of left joins in `ON`;
   - use `COUNT(DISTINCT external_complaint_id)` for complaints.
2. Put a header block (`/* ... */`) before the statement. List QUERY, STATUS (UNVALIDATED until you have checked it), GRAIN, NUMERATOR, DENOMINATOR, SOURCE TABLES, WINDOW and OUTPUT. `tests/test_sql_rules` enforces the header, the scope list and the IST anchor.
3. Create the query in Redash and paste the statement, without the header if you prefer. Put its id, and any parameters, in `QUERIES[<charter_key>]`.
4. If you are plugging in an existing query whose columns differ, map them with `QUERIES[<charter_key>]["columns"]` instead of editing the SQL.
5. For a CSV export, save it as `<charter_key>.csv` in the `--csv-dir` folder.
6. For a new result set, not a replacement:
   - add its contract to `RESULT_SETS` and its label to `SOURCE_LABELS`;
   - compute it in the matching `*_payload` function;
   - render it in the matching `*HTML` function of the template;
   - add its rows to `worklistRows` so the CSV export carries them.

## Data control checks

Run on every generation, shown in the strip:

1. Every allowlist outlet is present in each result set. An absent store gets a NO DATA exception in the CM view.
2. The store count in the output equals 48, and the clusters are 28 and 20.
3. Every query is fresh: present, not pending access, and younger than the staleness limit.
4. There is no negative wastage. Any occurrence is flagged as a data integrity issue, not an ops issue.
5. No day has orders above zero with GMV zero.
6. No result set has duplicate rows on its grain.
7. Total per order equals the sum of heads, and every formula component sits in exactly one head.
8. Loss data reaches D-1 and no later, so there is no partial day.
9. The store master covers all 48 outlets.
10. All values parsed.
11. The second source's total equals the sum of its heads, and in-transit is within forward.

## Rules implemented

- **Total.** BSD + BSE + BSNTE + Variance + Bad Returns + LIT + Damage + Short + Refund + RSTO Open Billed + RSTO Open DN Short + RSTO Total Dump - ESTO.
  - Variance = Manual Negative - Manual Positive.
  - Damage = DN Other + NR.
  - Short = Open DN Short.
  - `total_by_formula` keeps this literal. The heads are built from the same components through `HEADS`.
- **ESTO** nets against forward as a credit.
- **RTS short** sits in the reverse head (inferred) but is not in the total formula, so the heads sum to total + RTS short. The page says this next to the identity.
- **CRWI** is a separate line, not netted.
- **FNV and Milk** are outside the total, as central keeps them. They are their own column in every view.
- **Second source.** Where the central sheet is loaded, the higher number is shown and the lower one beside it, and the state uses the higher.
- **Open variance and live (MTD) variance** are separate series, shown in separate places and never compared.
- **Crate attributable OpenDN** shows a percentage only when both preconditions are met; otherwise it shows "not usable yet".
- **Never on the page:** a ranking on absolute rupees, a pie, a dual axis, or a composite score. The CM sort is by state, then by level as a share of its threshold.

## Tests

```bash
python3 -m pip install pytest
python3 -m pytest -q tests/
```

The tests cover the following:

- the identity, recomputed independently from raw CSV with the literal formula;
- head membership;
- the given thresholds;
- state rules;
- the BROKEN flag against each threshold, and the higher of two sources;
- the discriminator;
- CM grouping and the unassigned CM;
- a self-contained HTML file;
- each fault type caught by the control strip;
- pending access greyed rather than omitted;
- a missing store master;
- the SQL house rules;
- the Redash client: stored result, job polling, access denied, HTTP 403, pending, not configured.

## Files

- `generate_uk_sm_dashboard.py`: the generator (CONFIG, loaders, checks, computation, embedded HTML template).
- `make_sample_data.py`: writes SAMPLE result sets and a sample store master. `--faults` injects data faults for testing the strip.
- `queries/`: one UNVALIDATED SQL file per charter key.
- `vendor/echarts-5.5.1.min.js`: ECharts, inlined into the HTML at build time (Apache 2.0, see `vendor/ECHARTS_LICENSE.txt`).
- `tests/`: pytest suite.
