# Schema report from Claude in Chrome (21 Oct 2026, ~16:00 IST)

Answers HANDOFF_CHROME_SCHEMA.md. Read only: every statement ran unsaved via Redash `/api/query_results` (max_age 0). Nothing was saved, forked or scheduled.
Phone numbers, OTPs and mail IDs are left out of the sample rows.

```
Redash address: https://redash-queries.grofer.io   (found via Slack links; not in browser history)
Data source name used: [Warehouse] Trino   (id 660, type trino; the only data source this account sees)
```

## 1. storeops.activity columns
id:bigint, created_date:ts(3), last_modified_date:ts, assigned_time:ts, automatic_scan:bool, bag_count_required:bool, end_time:ts, exception_qty:double, expected_count:int, expected_end_time:ts, expected_start_time:ts, handshake_required:bool, item_qty:double, otp_expiry:ts, processed_qty:double, slot_end_date:ts, slot_start_date:ts, start_time:ts, version:int, er_id:bigint, receiver_assigned:bool, assign_receiver_triggered:bool, item_act_completion_time:ts, system_assigned:bool, prev_item_pick_time:ts, blocking_inventory:bool, entity_id:varchar, entity_ids:varchar, fulfillment_type:varchar, handshake_type:varchar, otp:varchar, prev_activity_id:varchar, reason_code:varchar, reason_text:varchar, seq_no:varchar, site_id:varchar, status:varchar, storage_types:varchar, total_seq_no:varchar, type:varchar, assigned_to_site_id:varchar, receiver_details:varchar, auxiliary_status:varchar, created_by:varchar, last_modified_by:varchar, activity_no:varchar, assigned_to_employee_id:varchar, assigned_to_first_name:varchar, assigned_to_last_name:varchar, assigned_to_mail_id:varchar, assigned_to_phone:varchar, assigned_to_role:varchar, assigned_to_user_id:varchar, banner:varchar, batch:varchar, device_id:varchar, drop_zone:varchar, lake_active_record:bool, _hoodie_* (record_key, incremental_key, file_name, partition_path, commit_time, commit_seqno)

NOTE: activity has **no insert_ds_ist** column. Filter on created_date (timestamps are UTC: +330 min for IST).

## 2. storeops.item_activity columns
id:bigint, created_by:varchar, created_date:ts, last_modified_by:varchar, last_modified_date:ts, activity_type:varchar, attempt_to_remove:bool, batch:varchar, batch_expiry_date:date, cancel_reason_code:varchar, completion_time:ts, exception_qty:double, expected_completion_time:ts, expiry_date:date, is_loc_scan_required:bool, is_scanned:bool, item_id:varchar, item_type:varchar, location_details:varchar, location_id:varchar, owner_id:varchar, prev_processed_qty:double, processed_qty:double, qty:double, reference_entity_id:varchar, reference_entity_type:varchar, seq_number:int, site_id:varchar, status:varchar, storage_type:varchar, uom:varchar, upc_id:varchar, use_batch:bool, variant_id:varchar, activity_id:bigint, er_line_id:bigint, reason_code:varchar, version:int, fulfilment_type:varchar, lake_active_record:bool, insert_ds_ist:varchar, _hoodie_*

## 3. storeops.inventory_update_log columns
id:varchar, created_by:varchar, created_date:ts, last_modified_by:varchar, last_modified_date:ts, comments:varchar, delta_qty:int, er_id:varchar, event_name:varchar, event_time:ts, expiry_date:date, inv_state:varchar, item_id:varchar, loc_id:varchar, new_qty:int, old_qty:int, site_id:varchar, supply_bucket:varchar, upc_id:varchar, variant_id:varchar, loc_inv_db_id:bigint, reason_code:varchar, sub_reason_code:varchar, item_activity_id:bigint, batch_expiry_date:date, owner_id:varchar, to_inv_state:varchar, item_details_id:bigint, product_info_id:bigint, src_site_id_of_sto:varchar, inward_er_type:varchar, tracking_level:varchar, lake_active_record:bool, insert_ds_ist:varchar, _hoodie_*

## 4. activity sample rows (7877, COMPLETED, last day)
All 5 newest were type PICKING (customer orders), so they show the shape but not audits. Key values:
- id 5459446750, type PICKING, status COMPLETED, auxiliary_status HANDOVER_COMPLETED, entity_id 3909297070 (order), created_date 2026-10-21 10:14:49 UTC, assigned_time 10:14:49, start_time 10:14:53, end_time 10:16:23, item_qty 7, processed_qty 7, expected_count 7, assigned_to_employee_id GCEB89332301233, assigned_to_first_name present, assigned_to_role NULL, created_by GR0001, assigned_to_user_id = employee id, system_assigned true, drop_zone G5, storage_types "REGULAR;CHILLED".
- The other 4 rows have the same shape.
- Freshness: [Fact] the newest row was created 10:14 UTC = 15:44 IST, while I queried at ~15:55 IST, so the lake lags about 10 to 15 minutes. That's enough for an hourly "on the floor now".

See 10 and 11 for INV_AUDIT activities.

## 5. item_activity sample rows
activity_type values seen: PICKING (reference_entity_type CUSTOMER_ORDER, status PROCESSED), PUTAWAY (CONSIGNMENT, status EXPECTED), **INV_AUDIT**:
- id 16192354650, created_by GCEB40398367918, created 2026-10-21 00:02:22 UTC, activity_type INV_AUDIT, item_id 10018785, location_id F0-CR01-002-04-C, location_details NULL, qty 1, processed_qty 1, reference_entity_id "LOCATION_AUDIT_V2-7877-2026-10-21T00:02:22.030419182Z", reference_entity_type INVENTORY_AUDIT_V2, status PROCESSED, storage_type FRIDGE, activity_id 5454066339, insert_ds_ist "2026-10-21".
- Picking lines carry the location in **location_details** (e.g. F0-A14-004-03-A), while audit lines carry it in **location_id**.

## 6. inventory_update_log event names (7877, insert_ds_ist >= yesterday)
RECORD_PICK 10804, CONSIGNMENT_PUTAWAY 6265, INV_AUDIT_TRANSFER 1176, **INV_AUDIT_INC 418**, RECORD_PUTAWAY 129, UPDATE_RTS_STOCK 101, **INV_AUDIT_DEC 61**, CUSTOMER_RETURN_BAD_EVENT 6

## 7. INV_AUDIT_DEC sample rows
Quantity column = **delta_qty** (negative for DEC), with old_qty / new_qty. The links are item_activity_id and loc_id. reason_code and sub_reason_code tell you who did it:
- created_by GCEB191318, 2026-10-20 06:00:50, delta -4, old 4 new 0, loc F0-A02-004-05-B, reason_code SYSTEM, sub NULL, item_activity_id 16165602173
- created_by GCEB82637604716, 2026-10-21 00:49:26, delta -1, old 1 new 0, loc F0-CR01-007-02-D, reason_code SELF, sub "Quantity Missing"
- created_by GR0001, 2026-10-20 18:04:59, delta -4, old 50 new 46, loc F0-A17-001-04-C, reason_code PRINTING_AUDIT, sub PRINTING_AUDIT
event_time was NULL in all 3; use created_date.

## 8. storeops tables
activity, complaint_rca, consignment_metrics, discrepancy_logs, er, er_container, er_container_item, erline, integrations_tracker, inventory_update_log, item_activity, item_details, item_exceptions, location, location_inventory, order_complaint, order_complaint_v2, site, user_details

No attendance or roster table in storeops. **storeops.user_details** is the roster (extra block 12 below).

### 12. Extra: show columns from storeops.user_details
id:bigint, employee_id:varchar, phone_number:varchar, role:varchar, user_id:varchar, site_id:varchar, first_name:varchar, mail_id:varchar, attendance_enabled:boolean, role_fungibility_enabled:boolean, meta_info:varchar, lake_active_record:boolean, _hoodie_*
=> Join on employee_id = activity.assigned_to_employee_id, scoped by site_id, to get first_name and role (captain names for crew chips). The phone and mail columns are not needed.

## 9. storeops_etls tables
**timed out** (`show tables from storeops_etls` passed 150 s and was cancelled).
- Retry 1: `select table_name from storeops_etls.information_schema.tables ...` gave `line 1:214: Catalog 'storeops_etls' not found` (my syntax: the schema was used as a catalog).
- Retry 2: `select table_name from information_schema.tables where table_schema = 'storeops_etls' and regexp_like(table_name, 'attend|roster|employee|...')` was still running after 2+ min; treat as timed out.
- Known from earlier work: `storeops_etls.daily_instore_item_level_wastage_tracking` and `storeops_etls.packaged_grn` exist.

## 10. Extra (read only): activity types at 7877, last day, with distinct people
PICKING COMPLETED 2910 (37 people) · **INV_AUDIT COMPLETED 1576 (30 people)** · PUTAWAY COMPLETED 748 (30) · INV_AUDIT RELEASED 118 (0, i.e. unassigned system tasks) · AD_HOC COMPLETED 32 (10) · CONSIGNMENT_LOADING 7 · CONSIGNMENT_UNLOADING 6 · RTS_PUTAWAY RELEASED 6 · BULK_PICKING 5 · INV_AUDIT IN_PROGRESS 5 · ASSET_AUDIT_PENDENCY · INV_AUDIT CANCELLED 2 …
INV_AUDIT is a mix of many flows, not just location audits; see 11 before using it.

## 11. Extra: what INV_AUDIT actually contains (7877, COMPLETED, last day)
Columns: reason_code | split_part(entity_id,'-',1) | created_by = assigned_to_employee_id | n | distinct people | avg seconds (end - start) | avg item_qty | last created (UTC)
```
SELF|LOCATION_AUDIT_V2|true|496|11|142.9|10.8|2026-10-21 07:15:59      <- the human location audit
GOOD_STOCK_MIGRATION_FNV|GOOD_STOCK_MIGRATION_FNV|true|377|3|0.2|6.5   <- instant system-style moves, not audits
Business Request|ITEM_AUDIT_V2|true|298|11|180||2026-10-21 02:53:57    <- item audits (system tasks, e.g. Parth's high-value)
STORE_ASSET_RETURN|STORE_ASSET_RETURN|true|221|11|0.1|1
GOOD_STOCK_MIGRATION|GOOD_STOCK_MIGRATION|true|65|9|0.2|7.2
SYSTEM|ITEM_EXPIRY_AUDIT|false|38|10|1577.1|4.2
Mishandled at your facility|...|true|25|7|0.1|7.8
expired_milk_audits|ITEM_AUDIT_V2|false|8|1|31.1
ITEM_MISSING|ITEM_MISSING|true|7|1|258.9|0
PRINTING_AUDIT|PRINTING_AUDIT|true|6|1 (GR0001 = system user)|0.1|4
Vendor Product Damage|...|true|6|1|0.2|61
quality_issue_customer|ITEM_AUDIT_V2|false|4|4|14718.7
product_damaged|ITEM_AUDIT_V2|false|3|3|6826.6
NR (Not Received F&V)|...|true|3|1|0.2|5.7
LOGISTICS|<numeric entity>|true|1-2 each|1|0.1|1
wrong_items_received|FNV_ITEM_AUDIT_V2|false|2|2|43300.6
RECONCILIATION|<numeric entity>|true|1 each|1|30-236|1-17
PNA|ITEM_AUDIT_V2|false|1|1|7.9
quality_issue_customer|FNV_ITEM_AUDIT_V2|false|1|1|70057.4
Variant Mismatch|VARIANT_...  (truncated)
```
Sample INV_AUDIT rows also show created_by = assigned_to_employee_id, with assigned_to_first_name and assigned_to_role NULL and start = end within a second for PRINTING_AUDIT and STORE_ASSET_RETURN.

**What this means for the queries:**
- [Inference] The location audits to rate and count are type = 'INV_AUDIT' and status = 'COMPLETED', filtered on **entity_id like 'LOCATION_AUDIT_V2-%'** (reason_code 'SELF'). At 7877 that's 496 sessions by 11 people in about 1.5 days, averaging 143 s and 10.8 items each.
- [Inference] Item audits (ITEM_AUDIT_V2, Business Request) are a separate flow, about 180 s each. Count them as audit work, but not toward "location audit IAPH".
- Exclude user GR0001 (system).
- The auditor is assigned_to_employee_id (= created_by for SELF). assigned_to_first_name is NULL on audits, so names must come from `storeops.user_details` or the roster export.
- One session's lines = item_activity where activity_id = a.id. Audit lines carry location_id, and reference_entity_id = activity entity_id.
- Audit outcome per line = inventory_update_log via item_activity_id with event_name in ('INV_AUDIT_INC','INV_AUDIT_DEC','INV_AUDIT_TRANSFER') and delta_qty. A "bad audit" signal is a DEC/INC on the same location soon after.

## Errors / timeouts
- 9: timed out (see above), plus `Catalog 'storeops_etls' not found` on my first retry.
- 1-8: no errors. Block 4 needed no fallback store; 7877 had data.

## Also for Claude Code (from the live install, 21 Oct)
- **Bug still in deploy/App.html line 99:** `INITIAL.indexOf('<?')`. HtmlService parses the `<?` as a scriptlet, and doGet then fails with "SyntaxError: Invalid or unexpected token (line N, file Code)". Fixed in the live project by changing it to `INITIAL.indexOf('<'+'?')`. Please make the same change in the repo, rebundle and add a test that no `<?` appears in App.html outside the two real scriptlets.
- **The v3 install is live** in Param's Grofers project (`1P3MoTV...`):
  - Setup has run, and health shows both required inputs OK (51 stores).
  - The first refresh was OK: 28.3 s, 51 stores, 7 AT_RISK, 44 SORTED, 0 BROKEN.
  - The RE_REFRESH and RE_MAINTAIN triggers are on, and alert_emails is set.
  - It's on the /dev test URL only; it isn't deployed yet.
- **inputs_sheet_id is deliberately left blank**, so the inputs stay in the app sheet. The new Grofers Inputs sheet is `1csiQryJr9_uJFLlh_qSzc-8Xu2ZUq6Wql-wzx3Ui0fo`; set it once the Redash syncs target it.
- **Parth's CSV exports are not usable.** They date from 6–8 Sep and cover only his 10 pilot stores (just 7877 overlaps with ours), and the engine only looks back 7 days of audits. That's why the audit queries must be written fresh.
