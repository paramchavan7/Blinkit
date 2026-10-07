/*
QUERY: audit_pending (charter: Variance)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: one row per pending audit task. Outlets with none get one coverage row (task_id null).
NUMERATOR: none (task list).
DENOMINATOR: none (task list).
SOURCE TABLES: replace_me.audit_tasks (task_id, outlet_id, audit_type in LOCATION, ITEM, EXPIRY, item_id,
               location_code, assigned_to_name, created_ts_ist, due_ts_ist, status), replace_me.item_dimension via max_by.
WINDOW: open at query run.
OUTPUT: outlet_id, task_id, audit_type, item_id, item_name, location, assigned_to, created_ts, due_ts
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
tasks as (
    select
        t.outlet_id,
        t.task_id,
        upper(t.audit_type) as audit_type,
        t.item_id,
        t.location_code as location,
        t.assigned_to_name as assigned_to,
        t.created_ts_ist as created_ts,
        t.due_ts_ist as due_ts
    from replace_me.audit_tasks t
    join scope s on s.outlet_id = t.outlet_id
    where t.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS')
      and upper(t.audit_type) in ('LOCATION', 'ITEM', 'EXPIRY')
)
select
    s.outlet_id,
    t.task_id,
    t.audit_type,
    t.item_id,
    d.item_name,
    t.location,
    t.assigned_to,
    t.created_ts,
    t.due_ts
from scope s
left join tasks t
    on t.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = t.item_id
order by s.outlet_id, t.created_ts
