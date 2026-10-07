/*
QUERY: near_expiry (charter: Wastage and expiry)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x item_id x location x expiry_date, not yet actioned. Outlets with none get one coverage row.
NUMERATOR: none (item list); qty and value per row.
DENOMINATOR: none (item list).
SOURCE TABLES: replace_me.inventory_batches (outlet_id, item_id, location_code, qty, value, expiry_date, near_expiry_flag,
               actioned_flag), replace_me.item_dimension via max_by.
WINDOW: at query run. 'Near expiry' is whatever near_expiry_flag means in the source (UNCONFIRMED).
OUTPUT: outlet_id, item_id, item_name, is_fnv, is_milk, location, qty, value, expiry_date
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
near as (
    select
        b.outlet_id,
        b.item_id,
        b.location_code as location,
        sum(b.qty) as qty,
        sum(b.value) as value,
        b.expiry_date
    from replace_me.inventory_batches b
    join scope s on s.outlet_id = b.outlet_id
    where b.near_expiry_flag
      and not b.actioned_flag
      and b.qty > 0
    group by b.outlet_id, b.item_id, b.location_code, b.expiry_date
)
select
    s.outlet_id,
    n.item_id,
    d.item_name,
    coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv,
    coalesce(d.l1_category = 'Milk', false) as is_milk,
    n.location,
    n.qty,
    n.value,
    n.expiry_date
from scope s
left join near n
    on n.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = n.item_id
order by s.outlet_id, n.expiry_date
