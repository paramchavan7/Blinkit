-- STORE_HEALTH_north.sql -> tab STORE_HEALTH_RAW. Daily store PPI (picking seconds per unit picked), last 8 IST days.
-- Parth's LiveHealth rule is PPI > 18 s and TFR < 99.5%. This query gives PPI only: TFR, R2A and surge need order / cart tables we have
-- not found yet, so the app marks a store BROKEN on PPI alone and never SEVERELY_BROKEN until TFR is added.
-- PPI here = sum(end - start of completed PICKING activities) / sum(units picked). Compare a few stores with Parth's PPI before trusting the 18 s line.
-- Source, confirmed in Redash (21 Oct 2026): storeops.activity (type PICKING, start_time, end_time UTC, processed_qty). Refresh daily.
with
-- >>> STORES: the one list to edit (same list in every query). Today: our 51 stores.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834
),
params as (select date(current_timestamp at time zone 'Asia/Kolkata') as today_ist),
picks as (
  select a.id,
         max(a.site_id) as outlet_id,
         max_by(a.status, a.last_modified_date) as status,
         max_by(a.start_time, a.last_modified_date) as start_utc,
         max_by(a.end_time, a.last_modified_date) as end_utc,
         max_by(a.processed_qty, a.last_modified_date) as qty
  from storeops.activity a
  cross join params p
  where a.type = 'PICKING'
    and a.created_date >= cast(p.today_ist - interval '9' day as timestamp)
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by a.id
),
daily as (
  select outlet_id, date(end_utc + interval '330' minute) as d,
         sum(qty) as picked_qty,
         sum(to_unixtime(end_utc) - to_unixtime(start_utc)) as picking_time_sec,
         count(*) as orders
  from picks
  where status = 'COMPLETED' and qty > 0 and end_utc is not null and start_utc is not null
    and to_unixtime(end_utc) - to_unixtime(start_utc) between 1 and 3600
  group by 1, 2
)
select
  cast(d.d as varchar) as metric_date,
  case when d.d = p.today_ist then 'PARTIAL' else 'COMPLETED_DAY' end as data_period_status,
  '' as region,
  d.outlet_id,
  '' as outlet_name,
  round(d.picking_time_sec / d.picked_qty, 2) as ppi,
  cast(null as double) as tfr_pct,
  cast(null as double) as r2a_sec,
  cast(null as double) as surge_pct,
  d.picked_qty,
  round(d.picking_time_sec) as picking_time_sec,
  d.orders
from daily d
cross join params p
where d.d >= p.today_ist - interval '8' day
order by d.outlet_id, d.d
