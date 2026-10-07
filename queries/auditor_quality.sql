/*
QUERY: auditor_quality (charter: Variance)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: outlet_id x dt (IST day) x auditor. Outlets with no audit activity get one coverage row (auditor null).
NUMERATOR: audit_seconds and inputs_correct.
DENOMINATOR: units_touched and inputs_total. The script recomputes
           seconds per unit and accuracy from these sums; never an average of daily averages.
SOURCE TABLES: replace_me.audit_log (outlet_id, auditor_name, audit_ts_ist, units_touched, audit_duration_seconds,
               input_count, input_correct_count).
WINDOW: 7 IST days ending current IST date minus 1 day.
OUTPUT: outlet_id, dt, auditor, units_touched, audit_seconds, inputs_total, inputs_correct
NOTES: the minimum-audit-time line is CONFIG MIN_AUDIT_SEC_PER_UNIT, or add a column min_audit_sec_per_unit here.
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
daily as (
    select
        a.outlet_id,
        date(a.audit_ts_ist) as dt,
        a.auditor_name as auditor,
        sum(a.units_touched) as units_touched,
        sum(a.audit_duration_seconds) as audit_seconds,
        sum(a.input_count) as inputs_total,
        sum(a.input_correct_count) as inputs_correct
    from replace_me.audit_log a
    join scope s on s.outlet_id = a.outlet_id
    cross join params p
    where date(a.audit_ts_ist) between p.report_date - interval '6' day and p.report_date
    group by 1, 2, 3
)
select
    s.outlet_id,
    d.dt,
    d.auditor,
    d.units_touched,
    d.audit_seconds,
    d.inputs_total,
    d.inputs_correct
from scope s
left join daily d
    on d.outlet_id = s.outlet_id
order by s.outlet_id, d.dt, d.auditor
