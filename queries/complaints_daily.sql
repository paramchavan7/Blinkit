/*
QUERY: complaints_daily (charter: Complaints)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
ACCESS: storeops.order_complaint_v2 access may be denied. If so, the page greys the Complaints sections as
        'source pending access'; do not work around it with another table silently.
GRAIN: outlet_id x dt (IST day of complaint creation). One row per outlet per day with delivered orders.
NUMERATOR: complaints = COUNT(DISTINCT external_complaint_id). Never a plain COUNT: the table is at product-line grain and a
           plain count inflates MDND. Each type is also COUNT(DISTINCT external_complaint_id) within the type.
DENOMINATOR: orders = COUNT(DISTINCT order_id) delivered on the same IST day (same definition as loss_daily).
SOURCE TABLES: storeops.order_complaint_v2 (external_complaint_id, order_id, complaint_type, product_id, created_at_ist),
               dwh.fact_sales_order_details (order to outlet, delivered orders), replace_me.item_dimension via max_by.
WINDOW: 45 IST days ending current IST date minus 1 day.
OUTPUT: outlet_id, dt, orders, complaints, mdnd, item_missing, item_damaged, item_expired, wrong_item, qng, qng_fnv
NOTES: complaint type labels in the CASE are UNVALIDATED. Priorities shown on the page: MDND P1, item missing P2, item expired P0.
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
orders as (
    select
        o.outlet_id,
        date(o.order_delivered_ts_ist) as dt,
        count(distinct o.order_id) as orders
    from dwh.fact_sales_order_details o
    join scope s on s.outlet_id = o.outlet_id
    cross join params p
    where o.order_current_status = 'DELIVERED'
      and date(o.order_delivered_ts_ist) between p.report_date - interval '44' day and p.report_date
    group by 1, 2
),
order_outlet as (
    select
        o.order_id,
        max(o.outlet_id) as outlet_id
    from dwh.fact_sales_order_details o
    join scope s on s.outlet_id = o.outlet_id
    cross join params p
    where date(o.order_delivered_ts_ist) between p.report_date - interval '50' day and p.report_date
    group by o.order_id
),
lines as (
    select
        oo.outlet_id,
        date(c.created_at_ist) as dt,
        c.external_complaint_id,
        case
            when upper(c.complaint_type) in ('MDND', 'MARKED_DELIVERED_NOT_DELIVERED') then 'MDND'
            when upper(c.complaint_type) in ('ITEM_MISSING', 'MISSING_ITEM') then 'ITEM_MISSING'
            when upper(c.complaint_type) in ('ITEM_DAMAGED', 'DAMAGED_ITEM') then 'ITEM_DAMAGED'
            when upper(c.complaint_type) in ('ITEM_EXPIRED', 'EXPIRED_ITEM') then 'ITEM_EXPIRED'
            when upper(c.complaint_type) in ('WRONG_ITEM', 'DIFFERENT_ITEM') then 'WRONG_ITEM'
            when upper(c.complaint_type) in ('QNG', 'QUALITY_NOT_GOOD') then 'QNG'
            else 'OTHER'
        end as ctype,
        coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv
    from storeops.order_complaint_v2 c
    join order_outlet oo on oo.order_id = c.order_id
    cross join params p
    left join item_dim d on d.item_id = c.product_id
    where date(c.created_at_ist) between p.report_date - interval '44' day and p.report_date
),
cmp as (
    select
        outlet_id,
        dt,
        count(distinct external_complaint_id) as complaints,
        count(distinct external_complaint_id) filter (where ctype = 'MDND') as mdnd,
        count(distinct external_complaint_id) filter (where ctype = 'ITEM_MISSING') as item_missing,
        count(distinct external_complaint_id) filter (where ctype = 'ITEM_DAMAGED') as item_damaged,
        count(distinct external_complaint_id) filter (where ctype = 'ITEM_EXPIRED') as item_expired,
        count(distinct external_complaint_id) filter (where ctype = 'WRONG_ITEM') as wrong_item,
        count(distinct external_complaint_id) filter (where ctype = 'QNG') as qng,
        count(distinct external_complaint_id) filter (where ctype = 'QNG' and is_fnv) as qng_fnv
    from lines
    group by 1, 2
)
select
    o.outlet_id,
    o.dt,
    o.orders,
    coalesce(c.complaints, 0) as complaints,
    coalesce(c.mdnd, 0) as mdnd,
    coalesce(c.item_missing, 0) as item_missing,
    coalesce(c.item_damaged, 0) as item_damaged,
    coalesce(c.item_expired, 0) as item_expired,
    coalesce(c.wrong_item, 0) as wrong_item,
    coalesce(c.qng, 0) as qng,
    coalesce(c.qng_fnv, 0) as qng_fnv
from orders o
left join cmp c
    on c.outlet_id = o.outlet_id
   and c.dt = o.dt
order by o.outlet_id, o.dt
