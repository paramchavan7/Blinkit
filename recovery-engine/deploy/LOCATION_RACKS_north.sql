-- LOCATION_RACKS_north.sql -> tab LOCATION_RECOVERY_RAW. One row per rack: how many locations it has, and how many show audit corrections.
-- rack_locations = locations used by any activity in the last 60 days. A location's correction days = days in the last 7 with an
-- audit increment or decrement there (INV_AUDIT_INC / INV_AUDIT_DEC by a person, not the system user GR0001).
-- direct = 2+ correction days, signal = 1+ (Parth's V1 thresholds; without location PPI, which his query had).
-- Refresh daily. Size: ~200-300 rows per store.
-- Source, confirmed in Redash (21 Oct 2026): storeops.item_activity (location_id for audits/putaway, location_details for picks),
-- storeops.inventory_update_log (event_name, loc_id, created_by, insert_ds_ist).
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
seen as (
  select ia.site_id as outlet_id, coalesce(nullif(ia.location_id, ''), ia.location_details) as location_id
  from storeops.item_activity ia
  cross join params p
  where ia.insert_ds_ist >= cast(p.today_ist - interval '60' day as varchar)
    and ia.site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
),
clean as (
  select outlet_id, location_id from seen
  where location_id is not null and location_id not in ('INTERIM_LOCATION', 'DAMAGED_LOCATION') and cardinality(split(location_id, '-')) = 5
),
corrections as (
  select l.site_id as outlet_id, l.loc_id as location_id, count(distinct substr(l.insert_ds_ist, 1, 10)) as days_corrected
  from storeops.inventory_update_log l
  cross join params p
  where l.insert_ds_ist >= cast(p.today_ist - interval '7' day as varchar)
    and l.insert_ds_ist < cast(p.today_ist as varchar)
    and l.event_name in ('INV_AUDIT_DEC', 'INV_AUDIT_INC')
    and l.created_by <> 'GR0001'
    and l.site_id in (select cast(outlet_id as varchar) from scope)
  group by 1, 2
)
select
  c.outlet_id,
  array_join(slice(split(c.location_id, '-'), 1, 3), '-') as rack_id,
  max(array_join(slice(split(c.location_id, '-'), 1, 2), '-')) as aisle_id,
  count(*) as rack_locations,
  count_if(coalesce(k.days_corrected, 0) >= 2) as direct_locations,
  count_if(coalesce(k.days_corrected, 0) >= 1) as signal_locations
from clean c
left join corrections k on k.outlet_id = c.outlet_id and k.location_id = c.location_id
group by 1, 2
order by 1, 2
