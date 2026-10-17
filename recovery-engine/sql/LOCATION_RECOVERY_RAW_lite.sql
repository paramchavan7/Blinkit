-- LOCATION_RECOVERY_RAW (lite) -> tab LOCATION_RECOVERY_RAW.
-- Backup only. Parth's own LOCATION_RECOVERY_RAW query is better because it also has location PPI. Fork his first.
-- What this gives the app:
--   * every location used in the last 60 days, so rack sweeps are sized from the real rack
--   * correction_days_7d = days in the last 7 on which an audit found the location short (INV_AUDIT_DEC)
-- It has no PPI, so the full-rack rule runs on correction days only.
-- Pilot stores only: one store has about 5,000 locations, and all 59 stores would be too many rows for the sheet.
with scope (outlet_id) as (
  values 7184, 6406, 7877, 6826, 4823, 7476, 3432, 7204, 8468, 8211
),
seen as (
  select a.site_id as outlet_id, ia.location_id
  from storeops.activity a
  inner join storeops.item_activity ia on a.id = ia.activity_id
  where date(a.created_date + interval '330' minute) >= current_date - interval '60' day
    and ia.insert_ds_ist >= cast(current_date - interval '60' day as varchar)
    and a.status = 'COMPLETED'
    and a.site_id in (select cast(outlet_id as varchar) from scope)
    and ia.location_id is not null
    and ia.location_id not in ('INTERIM_LOCATION', 'DAMAGED_LOCATION')
    and cardinality(split(ia.location_id, '-')) = 5
  group by 1, 2
),
short_days as (
  select l.site_id as outlet_id, l.loc_id as location_id, count(distinct substr(l.insert_ds_ist, 1, 10)) as correction_days_7d
  from storeops.inventory_update_log l
  where l.insert_ds_ist >= cast(current_date - interval '7' day as varchar)
    and l.insert_ds_ist < cast(current_date as varchar)
    and l.event_name = 'INV_AUDIT_DEC'
    and l.site_id in (select cast(outlet_id as varchar) from scope)
    and l.loc_id is not null
  group by 1, 2
)
select
  s.outlet_id,
  s.location_id,
  array_join(slice(split(s.location_id, '-'), 1, 2), '-') as aisle_id,
  array_join(slice(split(s.location_id, '-'), 1, 3), '-') as rack_id,
  coalesce(d.correction_days_7d, 0) as correction_days_7d,
  format_datetime(current_timestamp, 'yyyy-MM-dd HH:mm:ss') as raw_synced_at
from seen s
left join short_days d on d.outlet_id = s.outlet_id and d.location_id = s.location_id
order by 1, 2
