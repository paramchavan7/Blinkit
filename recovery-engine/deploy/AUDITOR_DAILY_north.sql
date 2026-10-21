-- AUDITOR_DAILY_north.sql -> tab AUDITOR_DAILY. Audits summed per auditor per day (last 8 days), North stores.
-- The app rates captains from this: IAPH = distinct SKUs per audit hour, QAPH = found qty per hour, bad audit % = sessions BELOW_PROVISIONAL_SOP.
-- Built on Parth's AUDIT_EXECUTION_RAW query (same two steps as AUDIT_SESSIONS_north.sql: North store list inside his query, then paste it below).
-- Refresh: hourly or daily. Size: about 10-30 rows per store per day.
select
  audit_date_ist, outlet_id, auditor_id,
  max(trim(concat(coalesce(cast(auditor_first_name as varchar), ''), ' ', coalesce(cast(auditor_last_name as varchar), '')))) as auditor_name,
  count(*) as sessions,
  sum(try_cast(session_elapsed_seconds as double)) as elapsed_seconds,
  sum(try_cast(distinct_skus as double)) as distinct_skus,
  sum(try_cast(found_qty as double)) as found_qty,
  count_if(coalesce(cast(quality_status as varchar), '') <> '') as judged_sessions,
  count_if(cast(quality_status as varchar) like 'BELOW%') as below_sop_sessions,
  cast(min(end_time) as varchar) as first_end_time,
  cast(max(end_time) as varchar) as last_end_time   -- end_time is a timestamp in Parth's query, so min / max are by time
from (
-- >>> PASTE PARTH'S AUDIT_EXECUTION_RAW QUERY BELOW THIS LINE
SELECT 1
-- <<< PASTE ABOVE THIS LINE (and delete the "SELECT 1" placeholder)
) parth
where session_status = 'COMPLETED'
  and try_cast(session_elapsed_seconds as double) > 0
  and try_cast(session_elapsed_seconds as double) <= 14400
group by 1, 2, 3
