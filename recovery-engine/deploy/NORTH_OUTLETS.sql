-- NORTH_OUTLETS.sql: helper, run once. Lists every dark store (business_type_id = 7) with its city, so you can pick the North stores.
-- Filter the result to the North cities, copy the outlet_id column, and paste it (comma separated) into the `scope` block of
-- RAWItemlevel_north.sql and STORE_VARIANCE_DAILY.sql, and into Parth's queries (see SETUP_GUIDE Part 4).
-- The same rows (outlet_id, outlet_name, city + your region / cluster / CM columns) become the STORE_MASTER tab: that tab decides which stores are live.
select id as outlet_id,
       max_by(name, updated_at) as outlet_name,
       max_by(location, updated_at) as city
from retail.console_outlet
where business_type_id = 7
group by id
order by 3, 2
