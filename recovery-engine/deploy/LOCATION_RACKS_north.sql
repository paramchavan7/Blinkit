-- LOCATION_RACKS_north.sql -> tab LOCATION_RECOVERY_RAW. One row per rack: how many locations it has, and how many show audit corrections.
-- rack_locations = locations used by any activity in the last 60 days. A location's correction days = days in the last 7 with an
-- audit increment or decrement there (INV_AUDIT_INC / INV_AUDIT_DEC by a person, not the system user GR0001).
-- direct = 2+ correction days, signal = 1+ (Parth's V1 thresholds; without location PPI, which his query had).
-- Refresh daily. Size: ~200-300 rows per store.
-- Source, confirmed in Redash (21 Oct 2026): storeops.item_activity (location_id for audits/putaway, location_details for picks),
-- storeops.inventory_update_log (event_name, loc_id, created_by, insert_ds_ist).
with
-- >>> STORES: the one list to edit (same list in every query). Today: our 51 stores.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834
),
params as (select date(current_timestamp at time zone 'Asia/Kolkata') as today_ist),
seen as (
  select ia.site_id as outlet_id, coalesce(nullif(ia.location_id, ''), ia.location_details) as location_id
  from storeops.item_activity ia
  cross join params p
  where ia.insert_ds_ist >= cast(p.today_ist - interval '60' day as varchar)
    and ia.site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
),
clean as (
  select outlet_id, location_id from seen
  where location_id is not null and location_id not in ('INTERIM_LOCATION', 'DAMAGED_LOCATION') and cardinality(split(location_id, '-')) = 5
),
corrections as (
  select l.site_id as outlet_id, l.loc_id as location_id, count(distinct substr(l.insert_ds_ist, 1, 10)) as days_corrected
  from storeops.inventory_update_log l
  cross join params p
  where l.insert_ds_ist >= cast(p.today_ist - interval '7' day as varchar)
    and l.insert_ds_ist < cast(p.today_ist as varchar)
    and l.event_name in ('INV_AUDIT_DEC', 'INV_AUDIT_INC')
    and l.created_by <> 'GR0001'
    and l.site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
)
select
  c.outlet_id,
  array_join(slice(split(c.location_id, '-'), 1, 3), '-') as rack_id,
  max(array_join(slice(split(c.location_id, '-'), 1, 2), '-')) as aisle_id,
  count(*) as rack_locations,
  count_if(coalesce(k.days_corrected, 0) >= 2) as direct_locations,
  count_if(coalesce(k.days_corrected, 0) >= 1) as signal_locations
from clean c
left join corrections k on k.outlet_id = c.outlet_id and k.location_id = c.location_id
group by 1, 2
order by 1, 2
