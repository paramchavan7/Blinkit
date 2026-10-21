-- Query 1 -> tab STORE_VARIANCE_DAILY (cfg: tab_store_variance). Feeds severity: open variance (gross negative ₹, 90d) and net variance (positive - negative ₹, 60d).
-- CHANGE vs original: window is now the current month + 2 previous months (was: from start of last month only, ~6 weeks).
with bounds as (
  select cast(date_trunc('month', current_date - interval '1' day) - interval '2' month as date) as lo   -- CHANGED: '1' -> '2'
),
-- >>> NORTH STORES: paste the same outlet list as in RAWItemlevel_north.sql.
scope (outlet_id) as (
  values 4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845, 8910, 8913, 8834,
    7184, 6406, 4823, 7476, 3432, 7204, 8468, 8211
)
select
  cast(a.date as date) as date_,
  cast(a.outlet_id as bigint) as outlet_id,
  max(a.outlet_name) as outlet_name,
  round(sum(coalesce(a.manual_negative_update_diff_instore, 0)), 2) as negative_amount,
  round(sum(coalesce(a.manual_positive_update_diff_instore, 0)), 2) as positive_amount,
  round(sum(coalesce(a.net_var, 0)), 2) as net_var,
  format_datetime(current_timestamp, 'yyyy-MM-dd HH:mm:ss') as raw_synced_at
from storeops_etls.agg_daily_store_level_wastage_metrics a
cross join bounds b
where a.date >= b.lo
  and a.date < current_date
  and a.outlet_id in (select outlet_id from scope)
group by 1, 2
order by 1 desc, 2
