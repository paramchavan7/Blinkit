/*
QUERY: wastage_daily (charter: Wastage and expiry)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x dt (IST day). One row per outlet per day with sales.
NUMERATOR: dump value (all, FNV, Milk); dump lines marked; NTE and expiry tasks closed; negative wastage lines.
DENOMINATOR: sales value (same category); dump lines eligible; NTE and expiry tasks created (by creation day).
SOURCE TABLES: dwh.fact_sales_order_item_details (sales by item, delivered), replace_me.dump_lines (outlet_id, dump_ts_ist,
               item_id, value, is_marked, is_marking_eligible), replace_me.nte_expiry_tasks (outlet_id, task_type, created_ts_ist,
               status), replace_me.item_dimension via max_by.
WINDOW: 45 IST days ending current IST date minus 1 day.
OUTPUT: outlet_id, dt, sales_total, sales_fnv, sales_milk, dump_total, dump_fnv, dump_milk, dump_lines_eligible, dump_lines_marked,
        nte_tasks_created, nte_tasks_closed, expiry_tasks_created, expiry_tasks_closed, negative_wastage_lines
NOTES: dump_total includes FNV and Milk; the page splits non-fresh, FNV, Milk. Negative dump values are kept, not clipped:
       the page flags them as a data integrity issue. The definition of 'eligible' for dump marking is UNCONFIRMED.
*/
with scope as (
    select outlet_id
    from unnest(array[4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076, 6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978, 4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191, 8408, 8119, 8490, 8681, 8896, 8845]) as t(outlet_id)
),
params as (
    select
        cast(current_timestamp at time zone 'Asia/Kolkata' as date) - interval '1' day as report_date,
        cast(current_timestamp at time zone 'Asia/Kolkata' as timestamp) as now_ist
),
item_dim as (
    select
        item_id,
        max_by(item_name, updated_at) as item_name,
        max_by(l0_category, updated_at) as l0_category,
        max_by(l1_category, updated_at) as l1_category
    from replace_me.item_dimension
    group by item_id
),
sales as (
    select
        o.outlet_id,
        date(o.order_delivered_ts_ist) as dt,
        sum(o.total_selling_price) as sales_total,
        sum(o.total_selling_price) filter (where coalesce(d.l0_category = 'Fruits & Vegetables', false)) as sales_fnv,
        sum(o.total_selling_price) filter (where coalesce(d.l1_category = 'Milk', false)) as sales_milk
    from dwh.fact_sales_order_item_details o
    join scope s on s.outlet_id = o.outlet_id
    cross join params p
    left join item_dim d on d.item_id = o.item_id
    where o.order_current_status = 'DELIVERED'
      and date(o.order_delivered_ts_ist) between p.report_date - interval '44' day and p.report_date
    group by 1, 2
),
dump as (
    select
        x.outlet_id,
        date(x.dump_ts_ist) as dt,
        sum(x.value) as dump_total,
        sum(x.value) filter (where coalesce(d.l0_category = 'Fruits & Vegetables', false)) as dump_fnv,
        sum(x.value) filter (where coalesce(d.l1_category = 'Milk', false)) as dump_milk,
        count(*) filter (where x.is_marking_eligible) as dump_lines_eligible,
        count(*) filter (where x.is_marking_eligible and x.is_marked) as dump_lines_marked,
        count(*) filter (where x.value < 0) as negative_wastage_lines
    from replace_me.dump_lines x
    join scope s on s.outlet_id = x.outlet_id
    cross join params p
    left join item_dim d on d.item_id = x.item_id
    where date(x.dump_ts_ist) between p.report_date - interval '44' day and p.report_date
    group by 1, 2
),
tasks as (
    select
        t.outlet_id,
        date(t.created_ts_ist) as dt,
        count(distinct t.task_id) filter (where upper(t.task_type) = 'NTE') as nte_tasks_created,
        count(distinct t.task_id) filter (where upper(t.task_type) = 'NTE' and t.status = 'CLOSED') as nte_tasks_closed,
        count(distinct t.task_id) filter (where upper(t.task_type) = 'EXPIRY') as expiry_tasks_created,
        count(distinct t.task_id) filter (where upper(t.task_type) = 'EXPIRY' and t.status = 'CLOSED') as expiry_tasks_closed
    from replace_me.nte_expiry_tasks t
    join scope s on s.outlet_id = t.outlet_id
    cross join params p
    where date(t.created_ts_ist) between p.report_date - interval '44' day and p.report_date
    group by 1, 2
)
select
    sa.outlet_id,
    sa.dt,
    sa.sales_total,
    sa.sales_fnv,
    sa.sales_milk,
    du.dump_total,
    du.dump_fnv,
    du.dump_milk,
    du.dump_lines_eligible,
    du.dump_lines_marked,
    ta.nte_tasks_created,
    ta.nte_tasks_closed,
    ta.expiry_tasks_created,
    ta.expiry_tasks_closed,
    du.negative_wastage_lines
from sales sa
left join dump du
    on du.outlet_id = sa.outlet_id
   and du.dt = sa.dt
left join tasks ta
    on ta.outlet_id = sa.outlet_id
   and ta.dt = sa.dt
order by sa.outlet_id, sa.dt
