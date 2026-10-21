# Claude in Chrome: read the warehouse columns so the audit queries can be written (about 15 min)

**Goal:** collect the real column names and sample rows from the tables that hold audit sessions and the roster. Then the audit-sessions and auditor-daily queries for our 51 stores can be written with no guessed names.
**You only read.** Run SELECT / SHOW statements only. Never create, edit or schedule anything, and never fork or change anyone's query.

## Steps
1. **Find Redash.** Search Chrome's history and bookmarks for "redash".
   - If there is nothing, open the C sheet https://docs.google.com/spreadsheets/d/1_JdCO5anThU-AqXTXiJ61jQyPBjT7FDi5mMzyiW1ktM . Find out how its `RAWItemlevel` tab is filled (sync add-on panel, data connector, or Extensions → Apps Script): that shows the Redash address.
   - Still nothing → stop and ask Param for the Redash address.
2. In Redash, click **New Query**. Pick the data source in which `select 1 from retail.console_outlet limit 1` runs: that is the warehouse Param's own queries use.
3. Run each block below **one at a time**. After each one, copy the full result (Redash's table view, or the "Copy" / CSV link) into your report under its number.
   - If a block errors, copy the exact error text and continue with the next block.
   - If a block runs longer than 2 minutes, cancel it, write "timed out", and continue.

```sql
-- 1. Audit header table: every column and its type
show columns from storeops.activity
```
```sql
-- 2. Audit line table
show columns from storeops.item_activity
```
```sql
-- 3. Inventory log (to confirm the audit increment event and the quantity column)
show columns from storeops.inventory_update_log
```
```sql
-- 4. Five recent completed activities at one of our stores (shows the type, user and time columns with real values)
select *
from storeops.activity a
where a.site_id = '7877'
  and a.status = 'COMPLETED'
  and date(a.created_date + interval '330' minute) >= current_date - interval '1' day
order by a.created_date desc
limit 5
```
```sql
-- 5. Their item lines
select ia.*
from storeops.item_activity ia
where ia.insert_ds_ist >= cast(current_date - interval '1' day as varchar)
  and ia.activity_id in (
    select a.id from storeops.activity a
    where a.site_id = '7877' and a.status = 'COMPLETED'
      and date(a.created_date + interval '330' minute) >= current_date - interval '1' day)
limit 10
```
```sql
-- 6. Which inventory events exist (looking for the audit increment, e.g. INV_AUDIT_INC)
select l.event_name, count(*) as n
from storeops.inventory_update_log l
where l.insert_ds_ist >= cast(current_date - interval '1' day as varchar)
  and l.site_id = '7877'
group by 1
order by 2 desc
```
```sql
-- 7. Three audit decrement rows (to see the quantity column)
select *
from storeops.inventory_update_log l
where l.insert_ds_ist >= cast(current_date - interval '1' day as varchar)
  and l.site_id = '7877'
  and l.event_name = 'INV_AUDIT_DEC'
limit 3
```
```sql
-- 8. Where the roster / attendance / picking data lives (for store health and the captain list)
show tables from storeops
```
```sql
-- 9. Same, in the ETL schema
show tables from storeops_etls
```

## If block 4 returns nothing
Change `'7877'` to `'6826'` in blocks 4, 5, 6 and 7 and run them again. If that is also empty, change `interval '1' day` to `interval '3' day`.

## Report back to Param (paste this filled in)
```
Redash address:
Data source name used:
1. activity columns:
2. item_activity columns:
3. inventory_update_log columns:
4. activity sample rows:
5. item_activity sample rows:
6. event names and counts:
7. INV_AUDIT_DEC sample rows:
8. storeops tables:
9. storeops_etls tables:
Errors / timeouts (block number + exact text):
```

## Rules
- Read only. No saved queries, schedules or forks. A query you leave unsaved is fine.
- Don't paste API keys, cookies or anything from the Redash settings page into the report.
- Stop and ask Param if Redash asks you to log in, request access, or choose between data sources you can't tell apart.
