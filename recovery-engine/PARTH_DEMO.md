# Demo for Parth (20 minutes, on live data)

**Goal:** the go-ahead for North, and his data fixes, in one meeting.

## Built on your V2 (say this first)
| From Parth's V2 / V1 | Where it is in the engine |
|---|---|
| LiveHealth rule: PPI > 18 s and TFR < 99.5% = severely broken; R2A > 30 s, surge > 2% = capacity | Store severity and capacity (CFG `sev_*`) |
| V1 full-rack rule: direct targets ≥25% or any-signal ≥50% of a rack | Broken-rack test. At North scale it is summed per rack in SQL over his LOCATION_RECOVERY_RAW |
| V2 time standard: 4.7 measured minutes per location, 0.4 measured-to-gross | Hours per task, and the locations-per-man-hour metric |
| Audit quality gate: BELOW_PROVISIONAL_SOP, expected-SKU coverage | Captain bad-audit %; MATCHED vs QUALITY_GAP (80% coverage) |
| His exports: STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW, AUDIT_EXECUTION_RAW, LOCATION_RECOVERY_RAW, PILOT_COHORT | Read as-is (forked, with the North store list) |

## Demo flow
1. **Control tower** (2 min): regions, broken / at risk / sorted, the goodness-metrics table, BROKEN vs CONTROL cohorts.
2. **SM view on a broken store** (6 min):
   - severity and why; the recommended recovery;
   - **Racks with most variance** → Do first;
   - crew: the most accurate auditors **on the floor now** come first;
   - confirm, then the printable sheet.
3. **Evidence** (4 min): Store results (suggested / planned / actual; locations audited from audit data; ₹ per man-hour; T+3 / T+7).
4. **CM view** (3 min): flags, then a decision with an owner.
5. **Monitoring** (2 min): hourly refresh, data health, errors, usage.
6. **Asks** (3 min, below).

## What's new versus V2
- **Presence:** who audited in the last 90 minutes (from the hourly audit export). The suggestion only uses people on the floor.
- **Accuracy beats speed** in the crew ranking. On the pilot data the fastest auditors are often the least accurate: at 7184 the 158.7-IAPH captain has 96.9% of audits below SOP.
- **Suggested vs planned vs actual** stored for every plan, and the SM is never asked why.
- **Audit evidence** classifies every session: MATCHED / QUALITY_GAP / OFF_PLAN / BASELINE (before confirmation).
- **North scale:** an hourly precompute; each screen opens in about 2 s at 200 stores (simulated); monitoring and alerts; archive.

## Asks for Parth
1. Edit access or fork rights on his 4 Redash queries, with the **North store list** inside them.
2. Confirm the **output column types**: `end_time` should be a timestamp (AUDITOR_DAILY sorts on it).
3. Review the **provisional thresholds**: severity ₹ lines, rack sweep at 4 items, aisle reset at 3 broken racks.
4. Agree the **go / no-go criteria** in METRICS.md for Fri 31 Oct.
