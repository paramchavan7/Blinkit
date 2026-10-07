/*
QUERY: reverse_open (charter: Reverse)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
ACCESS: warehouse_etls.all_reverse_consignment_raw is ACCESS DENIED (known). CONFIG marks this query pending_access,
        so the page greys the section 'source pending access'. Do not swap in another table silently.
GRAIN: outlet_id x doc_type (RSTO or RTS) x doc_id x state (OPEN_BILLED, OPEN_DISPATCH, DN_SHORT). Outlets with none get one
       coverage row (doc_id null).
NUMERATOR: none (document list); qty, value and fnv_value per document.
DENOMINATOR: none (document list).
SOURCE TABLES: warehouse_etls.all_reverse_consignment_raw (columns UNVALIDATED: outlet_id, doc_type, doc_id, doc_state, destination_name,
               qty, value, fnv_value, created_ts_ist).
WINDOW: open at query run.
OUTPUT: outlet_id, doc_type, doc_id, state, destination, qty, value, fnv_value, created_ts
NOTES: reverse loss per order on the page comes from loss_daily (gross, CRWI separate). Variance and RSTO are separate books.
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
docs as (
    select
        r.outlet_id,
        upper(r.doc_type) as doc_type,
        r.doc_id,
        upper(r.doc_state) as state,
        max(r.destination_name) as destination,
        sum(r.qty) as qty,
        sum(r.value) as value,
        sum(r.fnv_value) as fnv_value,
        min(r.created_ts_ist) as created_ts
    from warehouse_etls.all_reverse_consignment_raw r
    join scope s on s.outlet_id = r.outlet_id
    where upper(r.doc_type) in ('RSTO', 'RTS')
      and upper(r.doc_state) in ('OPEN_BILLED', 'OPEN_DISPATCH', 'DN_SHORT')
    group by r.outlet_id, upper(r.doc_type), r.doc_id, upper(r.doc_state)
)
select
    s.outlet_id,
    d.doc_type,
    d.doc_id,
    d.state,
    d.destination,
    d.qty,
    d.value,
    d.fnv_value,
    d.created_ts
from scope s
left join docs d
    on d.outlet_id = s.outlet_id
order by s.outlet_id, d.created_ts
