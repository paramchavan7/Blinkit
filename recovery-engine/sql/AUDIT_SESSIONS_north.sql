-- AUDIT_SESSIONS_north.sql -> tab AUDIT_EXECUTION_RAW. Location audit sessions of TODAY (IST), one row per session (yesterday's are kept in PLAN_RESULTS).
-- Refresh HOURLY: it tells the SM who is on the floor now and proves which planned locations were audited. The lake lags ~15 min.
-- Size: ~300-700 sessions per store per day (North stores = ~30,000-70,000 rows).
-- Source, confirmed in Redash (Trino, 21 Oct 2026): storeops.activity rows with type = 'INV_AUDIT', entity_id 'LOCATION_AUDIT_V2-<site>-<time>'
-- are the human location audits (item audits, stock migrations, asset returns and system tasks are left out); their lines are
-- storeops.item_activity (activity_id = activity.id). Lake timestamps are UTC; all output is IST. User GR0001 is the system.
-- Quality (provisional, ours): a session MEETS the SOP when at least 80% of its SKUs were processed and it took at least 3 s per SKU.
with
-- >>> NORTH SCOPE (from Param's North master query). Live regions: edit the region filter in `scope` (e.g. only 'UP West', 'Uttarakhand').
city_scope (source_city, city, region) as (
  values
    ('Rudrapur','Rudrapur','UP West'),('Chandausi','Chandausi','UP West'),('Dhampur','Dhampur','UP West'),('Kasganj','Kasganj','UP West'),
    ('Aligarh','Aligarh','UP West'),('Mainpuri','Mainpuri','UP West'),('Etah','Etah','UP West'),('Shivpuri','Shivpuri','UP West'),
    ('Orai','Orai','UP West'),('Mathura','Mathura','UP West'),('Agra','Agra','UP West'),('Bharatpur','Bharatpur','UP West'),
    ('Vrindavan','Vrindavan','UP West'),('Hathras','Hathras','UP West'),('Amroha','Amroha','UP West'),('Etawah','Etawah','UP West'),
    ('Jhansi','Jhansi','UP West'),('Rampur (Uttar Pradesh)','Rampur','UP West'),('Rampur','Rampur','UP West'),('Gwalior','Gwalior','UP West'),
    ('Morena','Morena','UP West'),('Datia','Datia','UP West'),('Bhind','Bhind','UP West'),('Moradabad','Moradabad','UP West'),
    ('Pilibhit','Pilibhit','UP West'),('Firozabad','Firozabad','UP West'),('Sambhal','Sambhal','UP West'),('Budaun','Budaun','UP West'),
    ('Badaun','Budaun','UP West'),('Kashipur','Kashipur','UP West'),('Shikohabad','Shikohabad','UP West'),('Bareilly','Bareilly','UP West'),
    ('Haldwani','Haldwani','UP West'),
    ('Roorkee','Roorkee','Uttarakhand'),('Vikasnagar','Vikasnagar','Uttarakhand'),('Haridwar','Haridwar','Uttarakhand'),
    ('Rishikesh','Rishikesh','Uttarakhand'),('Najibabad','Najibabad','Uttarakhand'),('Paonta Sahib','Paonta Sahib','Uttarakhand'),
    ('Dehradun','Dehradun','Uttarakhand'),('Kichha','Kichha','Uttarakhand'),('Saharanpur','Saharanpur','Uttarakhand'),
    ('Kotdwar','Kotdwar','Uttarakhand'),('Bijnor','Bijnor','Uttarakhand'),
    ('Rajpura','Rajpura','TriCity'),('Rupnagar','Rupnagar','TriCity'),('Ropar','Rupnagar','TriCity'),('New Chandigarh','New Chandigarh','TriCity'),
    ('Kharar','Kharar','TriCity'),('Mohali','Mohali','TriCity'),('SAS Nagar','Mohali','TriCity'),('Zirakpur','Zirakpur','TriCity'),
    ('Zirakhpur','Zirakpur','TriCity'),('Ambala','Ambala','TriCity'),('Pinjore','Pinjore','TriCity'),('Panchkula','Panchkula','TriCity'),
    ('Patiala','Patiala','TriCity'),('Kurali','Kurali','TriCity'),('Chandigarh','Chandigarh','TriCity'),
    ('Sundar Nagar','Sundar Nagar','ROP & HP'),('Sundernagar','Sundar Nagar','ROP & HP'),('Baddi','Baddi','ROP & HP'),('Manali','Manali','ROP & HP'),
    ('Phagwara','Phagwara','ROP & HP'),('Khanna','Khanna','ROP & HP'),('Amritsar','Amritsar','ROP & HP'),('Jalandhar','Jalandhar','ROP & HP'),
    ('Sangrur','Sangrur','ROP & HP'),('Pathankot','Pathankot','ROP & HP'),('Kapurthala','Kapurthala','ROP & HP'),('Abohar','Abohar','ROP & HP'),
    ('Ludhiana','Ludhiana','ROP & HP'),('Bathinda','Bathinda','ROP & HP'),('Bhatinda','Bathinda','ROP & HP'),('Muktsar','Muktsar','ROP & HP'),
    ('Sri Muktsar Sahib','Muktsar','ROP & HP'),('Gurdaspur','Gurdaspur','ROP & HP'),('Barnala','Barnala','ROP & HP'),
    ('Tarn Taran Sahib','Tarn Taran Sahib','ROP & HP'),('Tarn Taran','Tarn Taran Sahib','ROP & HP'),('Hoshiarpur','Hoshiarpur','ROP & HP'),
    ('Malerkotla','Malerkotla','ROP & HP'),('Malout','Malout','ROP & HP'),('Kangra','Kangra','ROP & HP'),('Una (Himachal Pradesh)','Una','ROP & HP'),
    ('Una','Una','ROP & HP'),('Faridkot','Faridkot','ROP & HP'),('Shimla','Shimla','ROP & HP'),('Firozpur','Firozpur','ROP & HP'),
    ('Ferozepur','Firozpur','ROP & HP'),('Moga','Moga','ROP & HP'),('Solan','Solan','ROP & HP'),('Hamirpur (Himachal Pradesh)','Hamirpur','ROP & HP'),
    ('Hamirpur','Hamirpur','ROP & HP'),('Dharamshala','Dharamshala','ROP & HP'),('Dharamsala','Dharamshala','ROP & HP'),('Batala','Batala','ROP & HP'),
    ('Jammu','Jammu','J&K'),('Srinagar (Jammu and Kashmir)','Srinagar','J&K'),('Srinagar','Srinagar','J&K'),('Udhampur','Udhampur','J&K'),
    ('Jodhpur','Jodhpur','Rajasthan'),('Jaipur','Jaipur','Rajasthan'),('Sawai Madhopur','Sawai Madhopur','Rajasthan'),('Jhunjhunu','Jhunjhunu','Rajasthan'),
    ('Pali (Rajasthan)','Pali','Rajasthan'),('Pali','Pali','Rajasthan'),('Hanumangarh','Hanumangarh','Rajasthan'),('Bhilwara','Bhilwara','Rajasthan'),
    ('Danta Ramgarh','Danta Ramgarh','Rajasthan'),('Sri Ganganagar','Sri Ganganagar','Rajasthan'),('Ganganagar','Sri Ganganagar','Rajasthan'),
    ('Kishangarh','Kishangarh','Rajasthan'),('Kota','Kota','Rajasthan')
),
north as (   -- every live North dark store (same exclusions as the North master: draft / test / dummy / dark / ks / pg)
  select co.id as outlet_id, max_by(co.name, co.updated_at) as store_name, max(cs.city) as city, max(cs.region) as region
  from retail.console_outlet co
  left join retail.console_location cl on co.tax_location_id = cl.id
  join city_scope cs on lower(trim(cl.name)) = lower(trim(cs.source_city))
  where co.business_type_id = 7
    and lower(co.name) not like '%draft%' and lower(co.name) not like '%testing%' and lower(co.name) not like '%test%'
    and lower(co.name) not like '%dummy%' and lower(co.name) not like '%dark%' and lower(co.name) not like '%ks%' and lower(co.name) not like '%pg%'
  group by co.id
),
scope (outlet_id) as (
  select outlet_id from north
  where region in ('UP West', 'Uttarakhand', 'TriCity', 'ROP & HP', 'J&K', 'Rajasthan')   -- <<< live regions
),
params as (select date(current_timestamp at time zone 'Asia/Kolkata') as today_ist),
sess as (   -- one row per audit session (latest version of each activity row)
  select a.id,
         max(a.site_id) as outlet_id,
         max_by(a.assigned_to_employee_id, a.last_modified_date) as auditor_id,
         max_by(a.start_time, a.last_modified_date) as start_utc,
         max_by(a.end_time, a.last_modified_date) as end_utc,
         max_by(a.status, a.last_modified_date) as status
  from storeops.activity a
  cross join params p
  where a.type = 'INV_AUDIT'
    and a.entity_id like 'LOCATION_AUDIT_V2-%'
    and a.created_date >= cast(p.today_ist - interval '2' day as timestamp)
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by a.id
),
lines as (   -- one row per audited SKU line (latest version)
  select ia.id,
         max(ia.activity_id) as activity_id,
         max(ia.item_id) as item_id,
         max(ia.location_id) as location_id,
         max_by(ia.status, ia.last_modified_date) as status,
         max_by(ia.processed_qty, ia.last_modified_date) as processed_qty
  from storeops.item_activity ia
  cross join params p
  where ia.insert_ds_ist >= cast(p.today_ist - interval '2' day as varchar)
    and ia.activity_type = 'INV_AUDIT'
    and ia.site_id in (select cast(outlet_id as varchar) from scope)
  group by ia.id
),
per_session as (
  select s.id, s.outlet_id, s.auditor_id, s.start_utc, s.end_utc,
         date(s.end_utc + interval '330' minute) as d,
         max(l.location_id) as location_id,
         count(distinct l.item_id) as skus,
         count(distinct case when l.status = 'PROCESSED' then l.item_id end) as processed_skus,
         sum(coalesce(l.processed_qty, 0)) as found_qty,
         to_unixtime(s.end_utc) - to_unixtime(s.start_utc) as secs
  from sess s
  join lines l on l.activity_id = s.id
  where s.status = 'COMPLETED' and s.auditor_id is not null and s.auditor_id <> 'GR0001' and s.end_utc is not null
  group by 1, 2, 3, 4, 5
),
judged as (
  select ps.*,
         round(100.0 * processed_skus / nullif(skus, 0), 1) as coverage_pct,
         case when 100.0 * processed_skus / nullif(skus, 0) >= 80 and coalesce(secs, 0) >= 3 * skus then 'MEETS_PROVISIONAL_SOP' else 'BELOW_PROVISIONAL_SOP' end as quality_status
  from per_session ps
),
names as (
  select site_id, employee_id, max(first_name) as first_name, max(role) as role
  from storeops.user_details
  where site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
)
select
  cast(j.d as varchar) as audit_date_ist,
  j.outlet_id,
  j.location_id,
  array_join(slice(split(j.location_id, '-'), 1, 3), '-') as rack_id,
  'COMPLETED' as session_status,
  date_format(j.end_utc + interval '330' minute, '%Y-%m-%d %H:%i:%s') as end_time,
  j.auditor_id,
  j.skus as distinct_skus,
  j.found_qty,
  j.quality_status,
  round(j.secs, 1) as session_elapsed_seconds,
  j.coverage_pct as expected_sku_coverage_pct
from judged j
cross join params p
left join names n on n.site_id = j.outlet_id and n.employee_id = j.auditor_id
where j.d = p.today_ist
order by j.outlet_id, j.end_utc
