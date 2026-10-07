/*
QUERY: forward_open (charter: Forward and transfer, includes GRN putaway pending)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: one row per inbound consignment not yet fully put away. Outlets with none get one coverage row.
NUMERATOR: units unloaded and units put away (summed by the script).
DENOMINATOR: units expected on open consignments (summed by the script).
SOURCE TABLES: replace_me.inbound_consignments (consignment_id, outlet_id, source_name, status, live_priority, arrived_ts_ist,
               units_expected, units_unloaded, units_putaway, units_grn_done, value).
WINDOW: open at query run.
OUTPUT: outlet_id, consignment_id, source_name, status, priority, arrived_ts, units_expected, units_unloaded, units_putaway,
        grn_pending_units, value
NOTES: priority is the live P0, P1, P2 from source, not derived. grn_pending_units = GRN done but not put away.
       Age (minutes) and the 6-hour flag are computed by the script from arrived_ts and retrieved_at.
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
open_cn as (
    select
        c.outlet_id,
        c.consignment_id,
        c.source_name,
        upper(c.status) as status,
        upper(c.live_priority) as priority,
        c.arrived_ts_ist as arrived_ts,
        c.units_expected,
        c.units_unloaded,
        c.units_putaway,
        greatest(coalesce(c.units_grn_done, 0) - coalesce(c.units_putaway, 0), 0) as grn_pending_units,
        c.value
    from replace_me.inbound_consignments c
    join scope s on s.outlet_id = c.outlet_id
    where upper(c.status) not in ('CLOSED', 'PUTAWAY_COMPLETE', 'CANCELLED')
)
select
    s.outlet_id,
    o.consignment_id,
    o.source_name,
    o.status,
    o.priority,
    o.arrived_ts,
    o.units_expected,
    o.units_unloaded,
    o.units_putaway,
    o.grn_pending_units,
    o.value
from scope s
left join open_cn o
    on o.outlet_id = s.outlet_id
order by s.outlet_id, o.arrived_ts
