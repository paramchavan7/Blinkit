-- LOCATION_RACKS_lite.sql -> tab LOCATION_RECOVERY_RAW. Backup when Parth's location query is not available. One row per rack.
-- rack_locations = locations used in the last 60 days; direct = 2+ days in the last 7 with an audit decrement (audit found it short)
-- at that location; signal = 1+ such day. No PPI (Parth's query has it), so the full-rack rule runs on short-audit days only.
with
-- >>> NORTH STORES: paste the same outlet list as in RAWItemlevel_north.sql.
scope (outlet_id) as (
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
  select l.site_id as outlet_id, l.loc_id as location_id, count(distinct substr(l.insert_ds_ist, 1, 10)) as days_short
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
  array_join(slice(split(s.location_id, '-'), 1, 3), '-') as rack_id,
  max(array_join(slice(split(s.location_id, '-'), 1, 2), '-')) as aisle_id,
  count(*) as rack_locations,
  count_if(coalesce(d.days_short, 0) >= 2) as direct_locations,
  count_if(coalesce(d.days_short, 0) >= 1) as signal_locations
from seen s
left join short_days d on d.outlet_id = s.outlet_id and d.location_id = s.location_id
group by 1, 2
