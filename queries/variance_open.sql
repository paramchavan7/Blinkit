/*
QUERY: variance_open (charter: Variance)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x item_id x negative location, open now. Outlets with nothing open get one coverage row (item_id null).
NUMERATOR: open_qty and open_value (rupees) of the open shortage, positive numbers. No denominator here; the script divides
           by MTD delivered orders for the 0.70 per-order line.
DENOMINATOR: none in the query; the page uses MTD delivered orders from loss_daily (window UNCONFIRMED).
SOURCE TABLES: replace_me.variance_open_snapshot (outlet_id, item_id, location_code, zone_code, signed_qty, value, first_negative_ts_ist, status),
               replace_me.audit_log (outlet_id, item_id, auditor_name, audit_ts_ist), replace_me.item_location_inventory
               (outlet_id, item_id, location_code, qty, last_putaway_ts_ist), replace_me.inventory_inward_log
               (outlet_id, item_id, location_code, qty, inward_ts_ist), replace_me.item_dimension via max_by.
WINDOW: open at query run.
DISCRIMINATOR EVIDENCE: nearby_long_qty = open long (positive) qty of the same item in the same zone; inward_after_qty = inward of the
           same item at the outlet after first_negative_ts_ist. Both are computed (0 when no match) so the script can classify.
OUTPUT: outlet_id, item_id, item_name, is_fnv, open_qty, open_value, negative_location, probable_locations, last_auditor, last_audit_ts,
        first_negative_ts, nearby_long_qty, nearby_long_locations, inward_after_qty
NOTES: open variance is not live (MTD) variance; never compared.
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
shorts as (
    select
        v.outlet_id,
        v.item_id,
        v.location_code as negative_location,
        v.zone_code,
        -v.signed_qty as open_qty,
        abs(v.value) as open_value,
        v.first_negative_ts_ist as first_negative_ts
    from replace_me.variance_open_snapshot v
    join scope s on s.outlet_id = v.outlet_id
    where v.status = 'OPEN'
      and v.signed_qty < 0
),
longs as (
    select
        sh.outlet_id,
        sh.item_id,
        sh.negative_location,
        sum(v.signed_qty) as nearby_long_qty,
        array_join(array_agg(distinct v.location_code), '; ') as nearby_long_locations
    from shorts sh
    join replace_me.variance_open_snapshot v
        on v.outlet_id = sh.outlet_id
       and v.item_id = sh.item_id
       and v.zone_code = sh.zone_code
       and v.location_code <> sh.negative_location
       and v.status = 'OPEN'
       and v.signed_qty > 0
    group by 1, 2, 3
),
inward as (
    select
        sh.outlet_id,
        sh.item_id,
        sh.negative_location,
        sum(i.qty) as inward_after_qty
    from shorts sh
    join replace_me.inventory_inward_log i
        on i.outlet_id = sh.outlet_id
       and i.item_id = sh.item_id
       and i.inward_ts_ist > sh.first_negative_ts
    group by 1, 2, 3
),
probable as (
    select
        sh.outlet_id,
        sh.item_id,
        sh.negative_location,
        array_join(array_agg(distinct l.location_code), '; ') as probable_locations
    from shorts sh
    cross join params p
    join replace_me.item_location_inventory l
        on l.outlet_id = sh.outlet_id
       and l.item_id = sh.item_id
       and l.location_code <> sh.negative_location
       and (l.qty > 0 or l.last_putaway_ts_ist >= p.now_ist - interval '7' day)
    group by 1, 2, 3
),
last_audit as (
    select
        a.outlet_id,
        a.item_id,
        max_by(a.auditor_name, a.audit_ts_ist) as last_auditor,
        max(a.audit_ts_ist) as last_audit_ts
    from replace_me.audit_log a
    join scope s on s.outlet_id = a.outlet_id
    group by 1, 2
),
items as (
    select
        sh.outlet_id,
        sh.item_id,
        d.item_name,
        coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv,
        sh.open_qty,
        sh.open_value,
        sh.negative_location,
        pr.probable_locations,
        la.last_auditor,
        la.last_audit_ts,
        sh.first_negative_ts,
        coalesce(lg.nearby_long_qty, 0) as nearby_long_qty,
        lg.nearby_long_locations,
        coalesce(iw.inward_after_qty, 0) as inward_after_qty
    from shorts sh
    left join item_dim d on d.item_id = sh.item_id
    left join longs lg on lg.outlet_id = sh.outlet_id and lg.item_id = sh.item_id and lg.negative_location = sh.negative_location
    left join inward iw on iw.outlet_id = sh.outlet_id and iw.item_id = sh.item_id and iw.negative_location = sh.negative_location
    left join probable pr on pr.outlet_id = sh.outlet_id and pr.item_id = sh.item_id and pr.negative_location = sh.negative_location
    left join last_audit la on la.outlet_id = sh.outlet_id and la.item_id = sh.item_id
)
select
    s.outlet_id,
    i.item_id,
    i.item_name,
    i.is_fnv,
    i.open_qty,
    i.open_value,
    i.negative_location,
    i.probable_locations,
    i.last_auditor,
    i.last_audit_ts,
    i.first_negative_ts,
    i.nearby_long_qty,
    i.nearby_long_locations,
    i.inward_after_qty
from scope s
left join items i
    on i.outlet_id = s.outlet_id
order by s.outlet_id, i.open_value desc
