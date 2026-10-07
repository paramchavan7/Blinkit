/*
QUERY: forward_crates (charter: Forward and transfer)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: one row per outlet (left join from scope, so every outlet appears; nulls mean no source row).
NUMERATOR: crate scans done; crate attributable open DN value.
DENOMINATOR: crate scans expected; open DN value.
SOURCE TABLES: replace_me.crate_scans (outlet_id, crate_id, expected_scan, scanned, scan_ts_ist),
               replace_me.crate_inventory (outlet_id, crate_id, received_ts_ist, returned_flag),
               replace_me.open_dn_attribution (outlet_id, value, is_crate_attributable).
WINDOW: scans month to date; crate age and open DN at query run.
OUTPUT: outlet_id, scans_expected, scans_done, crate_attrib_open_dn_value, open_dn_value, crates_0_24h, crates_24_48h,
        crates_48_72h, crates_72h_plus
NOTES: crate attributable OpenDN is directional only; the page shows it only when adherence is about 100 percent and no
       consignment is open past 6 hours, otherwise 'not usable yet'.
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
scans as (
    select
        x.outlet_id,
        count(*) filter (where x.expected_scan) as scans_expected,
        count(*) filter (where x.expected_scan and x.scanned) as scans_done
    from replace_me.crate_scans x
    join scope s on s.outlet_id = x.outlet_id
    cross join params p
    where date(x.scan_ts_ist) between date_trunc('month', p.report_date) and p.report_date
    group by x.outlet_id
),
crate_age as (
    select
        c.outlet_id,
        count(*) filter (where date_diff('hour', c.received_ts_ist, p.now_ist) < 24) as crates_0_24h,
        count(*) filter (where date_diff('hour', c.received_ts_ist, p.now_ist) between 24 and 47) as crates_24_48h,
        count(*) filter (where date_diff('hour', c.received_ts_ist, p.now_ist) between 48 and 71) as crates_48_72h,
        count(*) filter (where date_diff('hour', c.received_ts_ist, p.now_ist) >= 72) as crates_72h_plus
    from replace_me.crate_inventory c
    join scope s on s.outlet_id = c.outlet_id
    cross join params p
    where not c.returned_flag
    group by c.outlet_id
),
open_dn as (
    select
        a.outlet_id,
        sum(a.value) filter (where a.is_crate_attributable) as crate_attrib_open_dn_value,
        sum(a.value) as open_dn_value
    from replace_me.open_dn_attribution a
    join scope s on s.outlet_id = a.outlet_id
    group by a.outlet_id
)
select
    s.outlet_id,
    sc.scans_expected,
    sc.scans_done,
    od.crate_attrib_open_dn_value,
    od.open_dn_value,
    ca.crates_0_24h,
    ca.crates_24_48h,
    ca.crates_48_72h,
    ca.crates_72h_plus
from scope s
left join scans sc on sc.outlet_id = s.outlet_id
left join crate_age ca on ca.outlet_id = s.outlet_id
left join open_dn od on od.outlet_id = s.outlet_id
order by s.outlet_id
