/*
QUERY: loss_events (charter: store summary, incidents)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: one row per single loss event (event_id). Outlets with no event get one coverage row with event_id null.
NUMERATOR: rupees of the single event.
DENOMINATOR: none (event list).
SOURCE TABLES: replace_me.store_loss_events (outlet_id, event_id, event_ts_ist, component, category_group, ref_id, item_id, rupees);
               replace_me.item_dimension via max_by.
WINDOW: 45 IST days ending current IST date minus 1 day.
FILTER: rupees >= 1000 is a size filter only. It must stay below INCIDENT_MIN_RUPEES in the script CONFIG.
OUTPUT: outlet_id, dt, event_id, head, component, ref_id, item_name, rupees
NOTES: head mapping mirrors CONFIG HEADS (reverse assignment inferred). FNV and Milk events excluded, as in the total.
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
events as (
    select
        e.outlet_id,
        date(e.event_ts_ist) as dt,
        e.event_id,
        case
            when e.component in ('BSD', 'BSE', 'BSNTE', 'MANUAL_NEGATIVE') then 'in_store'
            when e.component in ('DN_OTHER', 'NR', 'OPEN_DN_SHORT') then 'forward'
            when e.component in ('RSTO_OPEN_BILLED', 'RSTO_OPEN_DN_SHORT', 'RSTO_TOTAL_DUMP', 'RTS_SHORT') then 'reverse'
            when e.component in ('REFUND', 'BAD_RETURNS', 'LIT') then 'returns_refunds'
        end as head,
        lower(e.component) as component,
        e.ref_id,
        e.item_id,
        e.rupees
    from replace_me.store_loss_events e
    join scope s on s.outlet_id = e.outlet_id
    cross join params p
    where date(e.event_ts_ist) between p.report_date - interval '44' day and p.report_date
      and e.category_group = 'OTHER'
      and e.rupees >= 1000
)
select
    s.outlet_id,
    ev.dt,
    ev.event_id,
    ev.head,
    ev.component,
    ev.ref_id,
    d.item_name,
    ev.rupees
from scope s
left join events ev
    on ev.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = ev.item_id
order by s.outlet_id, ev.rupees desc
