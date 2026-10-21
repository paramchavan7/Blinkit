-- AUDIT_SESSIONS_north.sql -> tab AUDIT_EXECUTION_RAW. Audit sessions of TODAY and YESTERDAY only, North stores.
-- Built on Parth's AUDIT_EXECUTION_RAW query (its output columns are what the app reads). Two steps:
--   1. In Parth's query, find his store list (Cmd+F for 7184) and replace those IDs with the North list.
--   2. Paste his whole query between the two marker lines below. Delete the ; at its end if it has one.
-- Refresh: HOURLY. This is what tells the SM who is on the floor now, and proves which planned locations were audited.
-- Size: about 400-800 sessions per store per day (200 stores x 2 days = up to 300,000 rows): keep it in the separate inputs sheet.
select
  audit_date_ist, outlet_id, location_id, rack_id, session_status, end_time, auditor_id, auditor_first_name, auditor_last_name,
  distinct_skus, found_qty, quality_status, session_elapsed_seconds, expected_sku_coverage_pct
from (
-- >>> PASTE PARTH'S AUDIT_EXECUTION_RAW QUERY BELOW THIS LINE
SELECT 1
-- <<< PASTE ABOVE THIS LINE (and delete the "SELECT 1" placeholder)
) parth
where cast(audit_date_ist as date) >= current_date - interval '1' day
