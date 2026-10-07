/*
QUERY: complaints_open (charter: Complaints)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
ACCESS: storeops.order_complaint_v2 access may be denied; the page greys the section if so.
GRAIN: one row per open complaint (external_complaint_id). Product lines are collapsed with max_by, so a complaint is
       never repeated. Outlets with none get one coverage row (external_complaint_id null).
NUMERATOR: none (complaint list).
DENOMINATOR: none (complaint list).
SOURCE TABLES: storeops.order_complaint_v2 (external_complaint_id, order_id, complaint_type, product_id, status, created_at_ist),
               dwh.fact_sales_order_details (order to outlet), replace_me.order_picking (order_id, picker_name, picked_ts_ist),
               replace_me.item_dimension via max_by.
WINDOW: open at query run, created in the last 7 IST days.
OUTPUT: outlet_id, external_complaint_id, order_id, complaint_type, item_id, item_name, is_fnv, picker, created_ts
NOTES: age against the RCI 4-hour standard is computed by the script from created_ts and the result's retrieved_at.
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
order_outlet as (
    select
        o.order_id,
        max(o.outlet_id) as outlet_id
    from dwh.fact_sales_order_details o
    join scope s on s.outlet_id = o.outlet_id
    cross join params p
    where date(o.order_delivered_ts_ist) between p.report_date - interval '10' day and p.report_date + interval '1' day
    group by o.order_id
),
pickers as (
    select
        pk.order_id,
        max_by(pk.picker_name, pk.picked_ts_ist) as picker
    from replace_me.order_picking pk
    join order_outlet oo on oo.order_id = pk.order_id
    group by pk.order_id
),
open_c as (
    select
        oo.outlet_id,
        c.external_complaint_id,
        max(c.order_id) as order_id,
        max_by(case
            when upper(c.complaint_type) in ('MDND', 'MARKED_DELIVERED_NOT_DELIVERED') then 'MDND'
            when upper(c.complaint_type) in ('ITEM_MISSING', 'MISSING_ITEM') then 'ITEM_MISSING'
            when upper(c.complaint_type) in ('ITEM_DAMAGED', 'DAMAGED_ITEM') then 'ITEM_DAMAGED'
            when upper(c.complaint_type) in ('ITEM_EXPIRED', 'EXPIRED_ITEM') then 'ITEM_EXPIRED'
            when upper(c.complaint_type) in ('WRONG_ITEM', 'DIFFERENT_ITEM') then 'WRONG_ITEM'
            when upper(c.complaint_type) in ('QNG', 'QUALITY_NOT_GOOD') then 'QNG'
            else 'OTHER'
        end, c.created_at_ist) as complaint_type,
        max_by(c.product_id, c.created_at_ist) as item_id,
        min(c.created_at_ist) as created_ts
    from storeops.order_complaint_v2 c
    join order_outlet oo on oo.order_id = c.order_id
    cross join params p
    where c.status not in ('CLOSED', 'RESOLVED')
      and date(c.created_at_ist) >= p.report_date - interval '6' day
    group by oo.outlet_id, c.external_complaint_id
)
select
    s.outlet_id,
    oc.external_complaint_id,
    oc.order_id,
    oc.complaint_type,
    oc.item_id,
    d.item_name,
    coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv,
    pk.picker,
    oc.created_ts
from scope s
left join open_c oc
    on oc.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = oc.item_id
left join pickers pk
    on pk.order_id = oc.order_id
order by s.outlet_id, oc.created_ts
