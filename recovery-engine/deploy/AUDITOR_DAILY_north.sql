-- AUDITOR_DAILY_north.sql -> tab AUDITOR_DAILY. Location audits summed per auditor per IST day, last 8 days; plus, for TODAY,
-- everyone who did any floor work (picking, putaway, audits) with their latest time: that is "on the floor now".
-- The app rates captains on past days only (IAPH = SKUs per audit hour, QAPH = found qty per hour, bad % = BELOW sessions); today's rows
-- only mark presence, so pickers with zero audits today still show as on the floor. Refresh hourly. Size: ~20-60 rows per store per day.
-- Source, confirmed in Redash (Trino, 21 Oct 2026): storeops.activity rows with type = 'INV_AUDIT', entity_id 'LOCATION_AUDIT_V2-<site>-<time>'
-- are the human location audits (item audits, stock migrations, asset returns and system tasks are left out); their lines are
-- storeops.item_activity (activity_id = activity.id). Lake timestamps are UTC; all output is IST. User GR0001 is the system.
-- Quality (provisional, ours): a session MEETS the SOP when at least 80% of its SKUs were processed and it took at least 3 s per SKU.
with
-- >>> STORES: the one list to edit (same list in every query). Today: our 51 stores.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834
),
params as (select date(current_timestamp at time zone 'Asia/Kolkata') as today_ist),
sess as (   -- one row per audit session (latest version of each activity row)
  select a.id,
         max(a.site_id) as outlet_id,
         max_by(a.assigned_to_employee_id, a.last_modified_date) as auditor_id,
         max_by(a.start_time, a.last_modified_date) as start_utc,
         max_by(a.end_time, a.last_modified_date) as end_utc,
         max_by(a.status, a.last_modified_date) as status
  from storeops.activity a
  cross join params p
  where a.type = 'INV_AUDIT'
    and a.entity_id like 'LOCATION_AUDIT_V2-%'
    and a.created_date >= cast(p.today_ist - interval '9' day as timestamp)
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by a.id
),
lines as (   -- one row per audited SKU line (latest version)
  select ia.id,
         max(ia.activity_id) as activity_id,
         max(ia.item_id) as item_id,
         max(ia.location_id) as location_id,
         max_by(ia.status, ia.last_modified_date) as status,
         max_by(ia.processed_qty, ia.last_modified_date) as processed_qty
  from storeops.item_activity ia
  cross join params p
  where ia.insert_ds_ist >= cast(p.today_ist - interval '9' day as varchar)
    and ia.activity_type = 'INV_AUDIT'
    and ia.site_id in (select cast(outlet_id as varchar) from scope)
  group by ia.id
),
per_session as (
  select s.id, s.outlet_id, s.auditor_id, s.start_utc, s.end_utc,
         date(s.end_utc + interval '330' minute) as d,
         max(l.location_id) as location_id,
         count(distinct l.item_id) as skus,
         count(distinct case when l.status = 'PROCESSED' then l.item_id end) as processed_skus,
         sum(coalesce(l.processed_qty, 0)) as found_qty,
         to_unixtime(s.end_utc) - to_unixtime(s.start_utc) as secs
  from sess s
  join lines l on l.activity_id = s.id
  where s.status = 'COMPLETED' and s.auditor_id is not null and s.auditor_id <> 'GR0001' and s.end_utc is not null
  group by 1, 2, 3, 4, 5
),
judged as (
  select ps.*,
         round(100.0 * processed_skus / nullif(skus, 0), 1) as coverage_pct,
         case when 100.0 * processed_skus / nullif(skus, 0) >= 80 and coalesce(secs, 0) >= 3 * skus then 'MEETS_PROVISIONAL_SOP' else 'BELOW_PROVISIONAL_SOP' end as quality_status
  from per_session ps
),
names as (
  select site_id, employee_id, max(first_name) as first_name, max(role) as role
  from storeops.user_details
  where site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
),
daily as (
  select d, outlet_id, auditor_id,
         count(*) as sessions,
         sum(case when secs > 0 and secs <= 14400 then secs else 0 end) as elapsed_seconds,
         sum(skus) as distinct_skus,
         sum(found_qty) as found_qty,
         count(*) as judged_sessions,
         count_if(quality_status = 'BELOW_PROVISIONAL_SOP') as below_sop_sessions,
         min(end_utc) as first_end_utc,
         max(end_utc) as last_end_utc
  from judged
  group by 1, 2, 3
),
floor_today as (   -- any assigned floor work today, finished or in progress
  select p.today_ist as d, a.site_id as outlet_id, a.assigned_to_employee_id as employee_id,
         max(coalesce(a.end_time, a.last_modified_date, a.start_time)) as last_seen_utc
  from storeops.activity a
  cross join params p
  where a.created_date >= cast(p.today_ist - interval '1' day as timestamp)
    and date(coalesce(a.end_time, a.last_modified_date, a.start_time) + interval '330' minute) = p.today_ist
    and a.status in ('COMPLETED', 'IN_PROGRESS')
    and a.type in ('PICKING', 'BULK_PICKING', 'PUTAWAY', 'RTS_PUTAWAY', 'INV_AUDIT', 'AD_HOC')
    and a.assigned_to_employee_id is not null and a.assigned_to_employee_id <> 'GR0001'
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2, 3
)
select
  cast(coalesce(dy.d, f.d) as varchar) as audit_date_ist,
  coalesce(dy.outlet_id, f.outlet_id) as outlet_id,
  coalesce(dy.auditor_id, f.employee_id) as auditor_id,
  n.first_name as auditor_name,
  coalesce(dy.sessions, 0) as sessions,
  coalesce(round(dy.elapsed_seconds, 1), 0) as elapsed_seconds,
  coalesce(dy.distinct_skus, 0) as distinct_skus,
  coalesce(dy.found_qty, 0) as found_qty,
  coalesce(dy.judged_sessions, 0) as judged_sessions,
  coalesce(dy.below_sop_sessions, 0) as below_sop_sessions,
  date_format(coalesce(dy.first_end_utc, f.last_seen_utc) + interval '330' minute, '%Y-%m-%d %H:%i:%s') as first_end_time,
  date_format(greatest(coalesce(dy.last_end_utc, f.last_seen_utc), coalesce(f.last_seen_utc, dy.last_end_utc)) + interval '330' minute, '%Y-%m-%d %H:%i:%s') as last_end_time
from daily dy
full outer join floor_today f on f.d = dy.d and f.outlet_id = dy.outlet_id and f.employee_id = dy.auditor_id
left join names n on n.site_id = coalesce(dy.outlet_id, f.outlet_id) and n.employee_id = coalesce(dy.auditor_id, f.employee_id)
order by 2, 1, 3
