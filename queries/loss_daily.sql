/*
QUERY: loss_daily (charter: store summary)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x dt (IST day). One row per outlet per day that has delivered orders.
NUMERATOR: loss components in rupees, summed by IST day, FNV and Milk excluded from the component columns
           and reported in fnv_loss and milk_loss (central keeps them out of the total).
DENOMINATOR: orders = COUNT(DISTINCT order_id) delivered on the IST day. One of three delivered-order
             definitions; name the one you are judged on in CONFIG DENOMINATOR. gmv = sum of selling price.
SOURCE TABLES: dwh.fact_sales_order_details (orders, gmv); replace_me.store_loss_components_daily
               (outlet_id, dt, component, category_group in FNV, MILK, OTHER, rupees).
WINDOW: 45 IST days ending current IST date minus 1 day (no partial day).
OUTPUT: outlet_id, dt, orders, gmv, bsd, bse, bsnte, manual_negative, manual_positive, bad_returns, lit, dn_other,
        nr, open_dn_short, refund, rsto_open_billed, rsto_open_dn_short, rsto_total_dump, esto, rts_short, crwi,
        fwd_in_transit, fnv_loss, milk_loss
NOTES: components are not coalesced to zero; a null means the source had no row and the page says so.
       fwd_in_transit is the in-transit part (open billed + open dispatch) of forward and must be inside open_dn_short.
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
orders as (
    select
        o.outlet_id,
        date(o.order_delivered_ts_ist) as dt,
        count(distinct o.order_id) as orders,
        sum(o.total_selling_price) as gmv
    from dwh.fact_sales_order_details o
    join scope s on s.outlet_id = o.outlet_id
    cross join params p
    where o.order_current_status = 'DELIVERED'
      and date(o.order_delivered_ts_ist) between p.report_date - interval '44' day and p.report_date
    group by 1, 2
),
components as (
    select
        c.outlet_id,
        c.dt,
        sum(c.rupees) filter (where c.component = 'BSD' and c.category_group = 'OTHER') as bsd,
        sum(c.rupees) filter (where c.component = 'BSE' and c.category_group = 'OTHER') as bse,
        sum(c.rupees) filter (where c.component = 'BSNTE' and c.category_group = 'OTHER') as bsnte,
        sum(c.rupees) filter (where c.component = 'MANUAL_NEGATIVE' and c.category_group = 'OTHER') as manual_negative,
        sum(c.rupees) filter (where c.component = 'MANUAL_POSITIVE' and c.category_group = 'OTHER') as manual_positive,
        sum(c.rupees) filter (where c.component = 'BAD_RETURNS' and c.category_group = 'OTHER') as bad_returns,
        sum(c.rupees) filter (where c.component = 'LIT' and c.category_group = 'OTHER') as lit,
        sum(c.rupees) filter (where c.component = 'DN_OTHER' and c.category_group = 'OTHER') as dn_other,
        sum(c.rupees) filter (where c.component = 'NR' and c.category_group = 'OTHER') as nr,
        sum(c.rupees) filter (where c.component = 'OPEN_DN_SHORT' and c.category_group = 'OTHER') as open_dn_short,
        sum(c.rupees) filter (where c.component = 'REFUND' and c.category_group = 'OTHER') as refund,
        sum(c.rupees) filter (where c.component = 'RSTO_OPEN_BILLED' and c.category_group = 'OTHER') as rsto_open_billed,
        sum(c.rupees) filter (where c.component = 'RSTO_OPEN_DN_SHORT' and c.category_group = 'OTHER') as rsto_open_dn_short,
        sum(c.rupees) filter (where c.component = 'RSTO_TOTAL_DUMP' and c.category_group = 'OTHER') as rsto_total_dump,
        sum(c.rupees) filter (where c.component = 'ESTO' and c.category_group = 'OTHER') as esto,
        sum(c.rupees) filter (where c.component = 'RTS_SHORT' and c.category_group = 'OTHER') as rts_short,
        sum(c.rupees) filter (where c.component = 'CRWI' and c.category_group = 'OTHER') as crwi,
        sum(c.rupees) filter (where c.component in ('FWD_OPEN_BILLED', 'FWD_OPEN_DISPATCH') and c.category_group = 'OTHER') as fwd_in_transit,
        sum(case when c.component in ('MANUAL_POSITIVE', 'ESTO') then -c.rupees else c.rupees end)
            filter (where c.category_group = 'FNV' and c.component in ('BSD', 'BSE', 'BSNTE', 'MANUAL_NEGATIVE', 'MANUAL_POSITIVE', 'BAD_RETURNS', 'LIT', 'DN_OTHER', 'NR', 'OPEN_DN_SHORT', 'REFUND', 'RSTO_OPEN_BILLED', 'RSTO_OPEN_DN_SHORT', 'RSTO_TOTAL_DUMP', 'ESTO')) as fnv_loss,
        sum(case when c.component in ('MANUAL_POSITIVE', 'ESTO') then -c.rupees else c.rupees end)
            filter (where c.category_group = 'MILK' and c.component in ('BSD', 'BSE', 'BSNTE', 'MANUAL_NEGATIVE', 'MANUAL_POSITIVE', 'BAD_RETURNS', 'LIT', 'DN_OTHER', 'NR', 'OPEN_DN_SHORT', 'REFUND', 'RSTO_OPEN_BILLED', 'RSTO_OPEN_DN_SHORT', 'RSTO_TOTAL_DUMP', 'ESTO')) as milk_loss
    from replace_me.store_loss_components_daily c
    join scope s on s.outlet_id = c.outlet_id
    cross join params p
    where c.dt between p.report_date - interval '44' day and p.report_date
    group by 1, 2
)
select
    o.outlet_id,
    o.dt,
    o.orders,
    o.gmv,
    c.bsd, c.bse, c.bsnte, c.manual_negative, c.manual_positive, c.bad_returns, c.lit,
    c.dn_other, c.nr, c.open_dn_short, c.refund, c.rsto_open_billed, c.rsto_open_dn_short,
    c.rsto_total_dump, c.esto, c.rts_short, c.crwi, c.fwd_in_transit, c.fnv_loss, c.milk_loss
from orders o
left join components c
    on c.outlet_id = o.outlet_id
   and c.dt = o.dt
order by o.outlet_id, o.dt
