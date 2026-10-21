-- ROSTER_north.sql -> tab EMPLOYEE_CAPACITY_SYNC_RAW. One row per person who did floor work at a store in the last 7 days:
-- name and role (storeops.user_details), days active, hours by kind of work, and whether they worked yesterday (ACTIVE T-1).
-- Replaces Parth's EMPLOYEE_CAPACITY_SYNC_RAW for our stores (same column names). Refresh daily. Size: ~30-80 rows per store.
-- Source, confirmed in Redash (21 Oct 2026): storeops.activity (assigned_to_employee_id, type, start_time, end_time, UTC) + storeops.user_details.
with
-- >>> STORES: the one list to edit (same list in every query). Today: our 51 stores.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834
),
params as (select date(current_timestamp at time zone 'Asia/Kolkata') as today_ist),
work as (
  select a.id,
         max(a.site_id) as outlet_id,
         max_by(a.assigned_to_employee_id, a.last_modified_date) as employee_id,
         max_by(a.type, a.last_modified_date) as type,
         max_by(a.entity_id, a.last_modified_date) as entity_id,
         max_by(a.status, a.last_modified_date) as status,
         max_by(a.start_time, a.last_modified_date) as start_utc,
         max_by(a.end_time, a.last_modified_date) as end_utc
  from storeops.activity a
  cross join params p
  where a.created_date >= cast(p.today_ist - interval '8' day as timestamp)
    and a.type in ('PICKING', 'BULK_PICKING', 'PUTAWAY', 'RTS_PUTAWAY', 'INV_AUDIT', 'AD_HOC')
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by a.id
),
done as (
  select outlet_id, employee_id, type, entity_id, date(end_utc + interval '330' minute) as d,
         case when to_unixtime(end_utc) - to_unixtime(start_utc) between 0 and 14400 then to_unixtime(end_utc) - to_unixtime(start_utc) else 0 end as secs
  from work
  where status = 'COMPLETED' and employee_id is not null and employee_id <> 'GR0001' and end_utc is not null
),
people as (
  select d.outlet_id, d.employee_id,
         count(distinct case when d.d < p.today_ist then d.d end) as active_days_l7,
         max(d.d) as last_active_date,
         round(sum(case when d.d < p.today_ist then d.secs else 0 end) / 3600.0, 2) as total_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type in ('PICKING', 'BULK_PICKING') then d.secs else 0 end) / 3600.0, 2) as picker_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type in ('PUTAWAY', 'RTS_PUTAWAY') then d.secs else 0 end) / 3600.0, 2) as putter_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type = 'INV_AUDIT' and d.entity_id like 'LOCATION_AUDIT_V2-%' then d.secs else 0 end) / 3600.0, 2) as auditor_active_hours_l7,
         max(case when d.d = p.today_ist - interval '1' day then 1 else 0 end) as worked_t1
  from done d
  cross join params p
  where d.d >= p.today_ist - interval '7' day
  group by 1, 2
),
names as (
  select site_id, employee_id, max(first_name) as first_name, max(role) as role
  from storeops.user_details
  where site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
)
select
  cast(p.today_ist - interval '1' day as varchar) as snapshot_date,
  pe.outlet_id,
  pe.employee_id,
  coalesce(n.first_name, pe.employee_id) as employee_name,
  coalesce(n.role, '') as designation,
  pe.active_days_l7,
  cast(pe.last_active_date as varchar) as last_active_date,
  pe.total_active_hours_l7,
  pe.picker_active_hours_l7,
  pe.putter_active_hours_l7,
  pe.auditor_active_hours_l7,
  case when pe.worked_t1 = 1 then 'ACTIVE T-1' else 'ACTIVE L7 - NOT T-1' end as recent_presence_status
from people pe
cross join params p
left join names n on n.site_id = pe.outlet_id and n.employee_id = pe.employee_id
order by 2, 11 desc
