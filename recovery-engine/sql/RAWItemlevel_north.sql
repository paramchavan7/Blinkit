-- RAWItemlevel_north.sql -> tab RAWItemlevel. Item-level open variance, top 200 items per store, with NEG / probable locations and
-- audit proof: audit decrement / increment quantities and dates (storeops.inventory_update_log, quantity column delta_qty and event
-- INV_AUDIT_INC confirmed in Redash on 21 Oct 2026). With these the app prioritises T-1 / T-3 / T-7 negatives and counts an item as
-- FOUND when an audit increment lands after the plan. Edit only the `scope` block. Refresh daily before 10:00 IST.
with
-- >>> STORES: the one list to edit (same list in every query). Today: our 51 stores.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834
),
bounds as (
  select date_trunc('month', current_date - interval '1' day) as lo,
         current_date as hi
),
region_outlets as (
  select id as outlet_id, max_by(name, updated_at) as outlet_name, max_by(location, updated_at) as city
  from retail.console_outlet
  where business_type_id = 7
    and id in (select outlet_id from scope)
  group by id
),
item_dim as (
  select p.item_id, max_by(icd.name, p.id) as item_name
  from rpc.product_product p
  join rpc.item_category_details icd on icd.item_id = p.item_id
  where p.active = 1 and p.approved = 1 and p.lake_active_record and icd.lake_active_record
  group by p.item_id
),
base as (
  select date_trunc('month', dl.snapshot_date_ist) as month_start_date, dl.outlet_id, ro.outlet_name, ro.city, dl.item_id, it.item_name,
         coalesce(sum(dl.manual_negative_update_diff), 0) as negative,
         coalesce(sum(dl.manual_positive_update_diff), 0) as positive,
         coalesce(sum(dl.qty_manual_negative_update_diff), 0) as negative_qty,
         coalesce(sum(dl.qty_manual_positive_update_diff), 0) as positive_qty
  from dwh.agg_daily_diff_loss dl
  cross join bounds b
  inner join region_outlets ro on ro.outlet_id = dl.outlet_id
  inner join item_dim it on it.item_id = dl.item_id
  where dl.snapshot_date_ist >= b.lo and dl.snapshot_date_ist < b.hi
    and dl.item_id not in (10151164, 10151165, 10151166, 10151167, 10151168, 10151169, 10112495)
  group by 1, 2, 3, 4, 5, 6
  having coalesce(sum(dl.manual_negative_update_diff), 0) > 0
),
derived as (
  select month_start_date, outlet_id, outlet_name, city, item_id, item_name,
         case when positive > negative then 0 else negative - positive end as variance,
         case when positive_qty > negative_qty then 0 else negative_qty - positive_qty end as variance_qty
  from base
),
ranked as (
  select *, row_number() over (partition by outlet_id order by variance desc, item_id) as rnk
  from derived
  where variance_qty > 0
),
ranked_capped as (
  select * from ranked where rnk <= 200
),
location as (
  select a.site_id, ia.item_id, array_agg(distinct ia.location_id order by ia.location_id) as location_array
  from storeops.activity a
  inner join storeops.item_activity ia on a.id = ia.activity_id
  cross join bounds b
  where date(a.created_date + interval '330' minute) >= date_add('day', -30, b.lo)
    and ia.insert_ds_ist >= cast(date_add('day', -30, b.lo) as varchar)
    and a.status = 'COMPLETED'
    and a.site_id in (select cast(outlet_id as varchar) from region_outlets)
    and ia.item_id in (select cast(item_id as varchar) from ranked_capped)
    and ia.location_id is not null
    and ia.location_id not in ('INTERIM_LOCATION', 'DAMAGED_LOCATION')
  group by 1, 2
),
iul_base as (
  select l.site_id, l.item_id,
         array_agg(distinct case when l.event_name = 'INV_AUDIT_DEC' and l.loc_id <> 'DAMAGED_LOCATION' then l.loc_id end) filter (where l.event_name = 'INV_AUDIT_DEC' and l.loc_id <> 'DAMAGED_LOCATION') as neg_loc_array,
         sum(case when l.event_name = 'INV_AUDIT_DEC' then abs(l.delta_qty) else 0 end) as audit_decrement_qty,
         sum(case when l.event_name = 'INV_AUDIT_INC' then abs(l.delta_qty) else 0 end) as audit_increment_qty,
         array_agg(distinct substr(l.insert_ds_ist, 1, 10)) filter (where l.event_name = 'INV_AUDIT_DEC') as audit_decrement_dates,
         array_agg(distinct substr(l.insert_ds_ist, 1, 10)) filter (where l.event_name = 'INV_AUDIT_INC') as audit_increment_dates
  from storeops.inventory_update_log l
  cross join bounds b
  where l.insert_ds_ist >= cast(b.lo as varchar)
    and l.insert_ds_ist < cast(b.hi as varchar)
    and l.event_name in ('INV_AUDIT_DEC', 'INV_AUDIT_INC')
    and l.site_id in (select cast(outlet_id as varchar) from region_outlets)
    and l.item_id in (select cast(item_id as varchar) from ranked_capped)
  group by 1, 2
)
select
  rc.month_start_date, rc.outlet_id, rc.outlet_name, rc.city, rc.item_id, rc.item_name,
  rc.variance, rc.variance_qty, rc.rnk,
  ib.neg_loc_array,
  lo.location_array as probable_locations,
  coalesce(ib.audit_decrement_qty, 0) as audit_decrement_qty,
  coalesce(ib.audit_increment_qty, 0) as audit_increment_qty,
  ib.audit_decrement_dates,
  ib.audit_increment_dates,
  format_datetime(current_timestamp, 'yyyy-MM-dd HH:mm:ss') as raw_synced_at
from ranked_capped rc
left join location lo on lo.site_id = cast(rc.outlet_id as varchar) and lo.item_id = cast(rc.item_id as varchar)
left join iul_base ib on ib.site_id = cast(rc.outlet_id as varchar) and ib.item_id = cast(rc.item_id as varchar)
order by rc.outlet_name, rc.rnk
