/*
QUERY: wastage_open_tasks (charter: Wastage and expiry)
STATUS: UNVALIDATED. Written without access to the catalog. Every table prefixed replace_me. is a placeholder
        for a table I could not name; every column name is a best guess. Run, fix names, then remove this line.
GRAIN: one row per open NTE or expiry task. Outlets with none get one coverage row (task_id null).
NUMERATOR: none (task list); qty and value per task.
DENOMINATOR: none (task list).
SOURCE TABLES: replace_me.nte_expiry_tasks (task_id, outlet_id, task_type, item_id, location_code, qty, value, created_ts_ist,
               assigned_to_name, status), replace_me.item_dimension via max_by.
WINDOW: open at query run.
OUTPUT: outlet_id, task_id, task_type, item_id, item_name, is_fnv, is_milk, location, qty, value, created_ts, assigned_to
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
        upper(t.task_type) as task_type,
        t.item_id,
        t.location_code as location,
        t.qty,
        t.value,
        t.created_ts_ist as created_ts,
        t.assigned_to_name as assigned_to
    from replace_me.nte_expiry_tasks t
    join scope s on s.outlet_id = t.outlet_id
    where t.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS')
      and upper(t.task_type) in ('NTE', 'EXPIRY')
)
select
    s.outlet_id,
    t.task_id,
    t.task_type,
    t.item_id,
    d.item_name,
    coalesce(d.l0_category = 'Fruits & Vegetables', false) as is_fnv,
    coalesce(d.l1_category = 'Milk', false) as is_milk,
    t.location,
    t.qty,
    t.value,
    t.created_ts,
    t.assigned_to
from scope s
left join tasks t
    on t.outlet_id = s.outlet_id
left join item_dim d
    on d.item_id = t.item_id
order by s.outlet_id, t.created_ts
