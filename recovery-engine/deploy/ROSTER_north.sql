-- ROSTER_north.sql -> tab EMPLOYEE_CAPACITY_SYNC_RAW. One row per person who did floor work at a store in the last 7 days:
-- name and role (storeops.user_details), days active, hours by kind of work, and whether they worked yesterday (ACTIVE T-1).
-- Replaces Parth's EMPLOYEE_CAPACITY_SYNC_RAW for the North stores (same column names); names and designations from ops_management.user.
-- Refresh daily. Size: ~30-80 rows per store.
-- Source, confirmed in Redash (21 Oct 2026): storeops.activity (assigned_to_employee_id, type, start_time, end_time, UTC) + storeops.user_details.
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
work as (
  select a.id,
         max(a.site_id) as outlet_id,
         max_by(a.assigned_to_employee_id, a.last_modified_date) as employee_id,
         max_by(a.type, a.last_modified_date) as type,
         max_by(a.entity_id, a.last_modified_date) as entity_id,
         max_by(a.status, a.last_modified_date) as status,
         max_by(a.start_time, a.last_modified_date) as start_utc,
         max_by(a.end_time, a.last_modified_date) as end_utc
  from storeops.activity a
  cross join params p
  where a.created_date >= cast(p.today_ist - interval '8' day as timestamp)
    and a.type in ('PICKING', 'BULK_PICKING', 'PUTAWAY', 'RTS_PUTAWAY', 'INV_AUDIT', 'AD_HOC')
    and a.site_id in (select cast(outlet_id as varchar) from scope)
  group by a.id
),
done as (
  select outlet_id, employee_id, type, entity_id, date(end_utc + interval '330' minute) as d,
         case when to_unixtime(end_utc) - to_unixtime(start_utc) between 0 and 14400 then to_unixtime(end_utc) - to_unixtime(start_utc) else 0 end as secs
  from work
  where status = 'COMPLETED' and employee_id is not null and employee_id <> 'GR0001' and end_utc is not null
),
people as (
  select d.outlet_id, d.employee_id,
         count(distinct case when d.d < p.today_ist then d.d end) as active_days_l7,
         max(d.d) as last_active_date,
         round(sum(case when d.d < p.today_ist then d.secs else 0 end) / 3600.0, 2) as total_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type in ('PICKING', 'BULK_PICKING') then d.secs else 0 end) / 3600.0, 2) as picker_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type in ('PUTAWAY', 'RTS_PUTAWAY') then d.secs else 0 end) / 3600.0, 2) as putter_active_hours_l7,
         round(sum(case when d.d < p.today_ist and d.type = 'INV_AUDIT' and d.entity_id like 'LOCATION_AUDIT_V2-%' then d.secs else 0 end) / 3600.0, 2) as auditor_active_hours_l7,
         max(case when d.d = p.today_ist - interval '1' day then 1 else 0 end) as worked_t1
  from done d
  cross join params p
  where d.d >= p.today_ist - interval '7' day
  group by 1, 2
),
names as (
  select site_id, employee_id, max(first_name) as first_name, max(role) as role
  from storeops.user_details
  where site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
),
people_master as (   -- full names and designations, the same table the North master uses
  select employee_id, max(name) as name, max(designation) as designation
  from ops_management.user
  group by 1
)
select
  cast(p.today_ist - interval '1' day as varchar) as snapshot_date,
  pe.outlet_id,
  pe.employee_id,
  coalesce(pm.name, n.first_name, pe.employee_id) as employee_name,
  coalesce(pm.designation, n.role, '') as designation,
  pe.active_days_l7,
  cast(pe.last_active_date as varchar) as last_active_date,
  pe.total_active_hours_l7,
  pe.picker_active_hours_l7,
  pe.putter_active_hours_l7,
  pe.auditor_active_hours_l7,
  case when pe.worked_t1 = 1 then 'ACTIVE T-1' else 'ACTIVE L7 - NOT T-1' end as recent_presence_status
from people pe
cross join params p
left join names n on n.site_id = pe.outlet_id and n.employee_id = pe.employee_id
left join people_master pm on pm.employee_id = pe.employee_id
order by 2, 11 desc
