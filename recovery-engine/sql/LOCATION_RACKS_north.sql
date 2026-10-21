-- LOCATION_RACKS_north.sql -> tab LOCATION_RECOVERY_RAW. One row per RACK instead of one per location (a store has ~5,000 locations,
-- 200 stores would be 1 million rows; per rack it is ~250 rows per store).
-- Built on Parth's LOCATION_RECOVERY_RAW query: (1) in his query replace his store list (Cmd+F for 7184) with the North list,
-- (2) paste his whole query between the markers. Counts use Parth's V1 rule: direct target = location PPI more than 2 s above ideal
-- (measurable PPI only) or 2+ correction days in 7; any signal = PPI above ideal or 1+ correction day.
-- Note: with rack rows, the CFG settings direct_ppi_delta_sec / direct_correction_days / signal_correction_days do not apply (the rule is here).
-- Refresh: daily.
select
  outlet_id, rack_id, max(aisle_id) as aisle_id,
  count(distinct location_id) as rack_locations,
  count(distinct case when (current_ppi_signal_status = 'MEASURABLE' and try_cast(current_ppi as double) > try_cast(current_ideal_ppi as double) + 2)
                        or try_cast(correction_days_7d as double) >= 2 then location_id end) as direct_locations,
  count(distinct case when (current_ppi_signal_status = 'MEASURABLE' and try_cast(current_ppi as double) > try_cast(current_ideal_ppi as double))
                        or try_cast(correction_days_7d as double) >= 1 then location_id end) as signal_locations
from (
-- >>> PASTE PARTH'S LOCATION_RECOVERY_RAW QUERY BELOW THIS LINE
SELECT 1
-- <<< PASTE ABOVE THIS LINE (and delete the "SELECT 1" placeholder)
) parth
group by 1, 2
