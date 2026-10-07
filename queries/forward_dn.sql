/*
QUERY: forward_dn (charter: Forward and transfer)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x consignment_id x item_id x dn_type (SHORT or DAMAGE). Outlets with none get one coverage row.
NUMERATOR: qty and value of DN lines.
DENOMINATOR: none (line list).
SOURCE TABLES: replace_me.dn_lines (outlet_id, consignment_id, item_id, dn_type, qty,
               value, dn_ts_ist), replace_me.item_dimension via max_by.
WINDOW: month to date, IST, ending current IST date minus 1 day.
OUTPUT: outlet_id, dt, consignment_id, dn_type, item_id, item_name, is_fnv, qty, value
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
dn as (
    select
        x.outlet_id,
        min(date(x.dn_ts_ist)) as dt,
        x.consignment_id,
        upper(x.dn_type) as dn_type,
        x.item_id,
        sum(x.qty) as qty,
        sum(x.value) as value
    from replace_me.dn_lines x
    join scope s on s.outlet_id = x.outlet_id
    cross join params p
    where date(x.dn_ts_ist) between date_trunc('month', p.report_date) and p.report_date
      and upper(x.dn_type) in ('SHORT', 'DAMAGE')
    group by x.outlet_id, x.consignment_id, upper(x.dn_type), x.item_id
)
select
    s.outlet_id,
    dn.dt,
    dn.consignment_id,
    dn.dn_type,
    dn.item_id,
    d.item_name,
    coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv,
    dn.qty,
    dn.value
from scope s
left join dn
    on dn.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = dn.item_id
order by s.outlet_id, dn.value desc
