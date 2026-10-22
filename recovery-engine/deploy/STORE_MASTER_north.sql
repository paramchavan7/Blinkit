-- STORE_MASTER_north.sql -> tab STORE_MASTER (Inputs sheet). One row per live North store: this tab decides which stores are live.
-- Region and city from the North city list; CM and SM from storeops_etls.user_store_role_mapping (Param's North master query).
-- cluster = the CM's name, so stores group by CM in the views. low_order_window stays blank (type it if you know it). Refresh daily.
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
role_people as (   -- store role mapping, as in Param's North master
  select cast(srm.outlet_id as bigint) as outlet_id, srm.role_id, lower(trim(omu.email_id)) as email, omu.name, omu.phone
  from storeops_etls.user_store_role_mapping srm
  left join ops_management.user omu on srm.employee_id = omu.employee_id
  where cast(srm.outlet_id as bigint) in (select outlet_id from scope)
)
select
  n.outlet_id,
  n.store_name as outlet_name,
  n.city,
  n.region,
  coalesce(max(case when r.role_id = 'cluster-manager' then r.name end), 'CM unassigned') as cluster,
  concat('CM: ', coalesce(max(case when r.role_id = 'cluster-manager' then r.name end), '-'),
         ' · SM: ', coalesce(max(case when r.role_id = 'store-manager' then r.name end), '-')) as cm_sm,
  '' as low_order_window,
  max(case when r.role_id = 'ops-head' then r.name end) as ops_head,
  max(case when r.role_id = 'cluster-manager' then r.email end) as cluster_manager_email,
  max(case when r.role_id = 'store-manager' then r.email end) as store_manager_email,
  case when max(case when r.role_id = 'cluster-manager' then 1 end) is null then 'MISSING_CM'
       when max(case when r.role_id = 'store-manager' then 1 end) is null then 'MISSING_SM' else 'MASTER_OK' end as master_status
from north n
left join role_people r on r.outlet_id = n.outlet_id
where n.outlet_id in (select outlet_id from scope)
group by n.outlet_id, n.store_name, n.city, n.region
order by n.region, n.city, n.store_name
