#!/usr/bin/env python3
"""Write SAMPLE result sets (one CSV per charter key) for testing the dashboard in --csv-dir mode.

Everything this writes is generated test data, not real. The folder gets a _SAMPLE marker file and
the dashboard shows a SAMPLE banner when it reads from it. Store names and CMs are placeholders.

    python3 make_sample_data.py                    # writes sample_data/
    python3 make_sample_data.py --faults           # also injects data faults the control strip must catch
"""
from __future__ import annotations

import argparse
import datetime as dt
import random
from pathlib import Path

import pandas as pd

from generate_uk_sm_dashboard import ALLOWLIST, CLUSTERS, IST, LOSS_COLUMNS, total_by_formula

PROFILES = {
    # total rupees per order by phase: (baseline, last 3 days)
    "broken": (9.2, 9.6),
    "deteriorating": (4.6, 7.4),
    "chronic": (5.6, 5.7),
    "clean": (2.6, 2.5),
    "mid": (3.4, 3.6),
}
HEAD_SHARE = {"in_store": 0.45, "forward": 0.20, "reverse": 0.18, "returns_refunds": 0.17}


def split_components(total_po, orders, rnd, in_store_boost=1.0):
    """Rupee components for one store-day from a total per-order level."""
    t = total_po * orders
    jit = lambda: rnd.uniform(0.75, 1.25)  # noqa: E731
    ins = t * HEAD_SHARE["in_store"] * in_store_boost
    fwd = t * HEAD_SHARE["forward"]
    rev = t * HEAD_SHARE["reverse"]
    ret = t * HEAD_SHARE["returns_refunds"]
    var = ins * 0.25 * jit()
    c = {
        "bsd": ins * 0.30 * jit(), "bse": ins * 0.25 * jit(), "bsnte": ins * 0.20 * jit(),
        "manual_negative": var * 1.6, "manual_positive": var * 0.6,
        "dn_other": fwd * 0.35 * jit(), "nr": fwd * 0.15 * jit(), "open_dn_short": fwd * 0.60 * jit(),
        "esto": fwd * 0.10 * jit(),
        "rsto_open_billed": rev * 0.35 * jit(), "rsto_open_dn_short": rev * 0.25 * jit(),
        "rsto_total_dump": rev * 0.40 * jit(), "rts_short": rev * 0.05 * jit(),
        "refund": ret * 0.55 * jit(), "bad_returns": ret * 0.25 * jit(), "lit": ret * 0.20 * jit(),
    }
    c["crwi"] = rev * 0.08 * jit()
    c["fwd_in_transit"] = c["open_dn_short"] * 0.4 * jit()
    c["fnv_loss"] = orders * 1.4 * jit()
    c["milk_loss"] = orders * 0.3 * jit()
    return {k: round(v, 2) for k, v in c.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="sample_data")
    ap.add_argument("--report-date", help="YYYY-MM-DD (default: yesterday IST)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--faults", action="store_true", help="inject faults the data control strip must catch")
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    now = dt.datetime.now(IST).replace(microsecond=0)
    report = dt.date.fromisoformat(args.report_date) if args.report_date else now.date() - dt.timedelta(days=1)
    pull = now - dt.timedelta(minutes=20)
    pull_s = pull.isoformat()
    pull_naive = pull.replace(tzinfo=None)
    days = [report - dt.timedelta(days=i) for i in range(44, -1, -1)]
    mtd_start = report.replace(day=1)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Sample store master: placeholder names and CMs, three stores under 60 days, 8845 without a CM.
    cms = ["SAMPLE CM A", "SAMPLE CM B", "SAMPLE CM C", "SAMPLE CM D", "SAMPLE CM E"]
    new_stores = {8896: 41, 8845: 12, 8681: 55}
    master = []
    for i, oid in enumerate(ALLOWLIST):
        cluster = next(c for c, lst in CLUSTERS.items() if oid in lst)
        cm = "" if oid == 8845 else cms[(i // 10) % len(cms)]
        age = new_stores.get(oid, rnd.randint(120, 900))
        master.append({"outlet_id": oid, "store_name": f"SAMPLE {cluster.split()[0]} {oid}", "cm": cm,
                       "go_live": (report - dt.timedelta(days=age)).isoformat(), "type": "SAMPLE", "mode": "SAMPLE"})
    pd.DataFrame(master).to_csv(out / "stores.csv", index=False)
    go_live = {m["outlet_id"]: dt.date.fromisoformat(m["go_live"]) for m in master}

    names = ["Atta 5kg", "Toned milk 500ml", "Banana robusta", "Onion 1kg", "Paneer 200g", "Curd 400g", "Bread white",
             "Eggs 6", "Tomato 500g", "Basmati 1kg", "Detergent 1kg", "Biscuits 200g", "Chips 52g", "Cola 750ml",
             "Coriander 100g", "Apple shimla 4pc", "Butter 100g", "Ghee 1L", "Sugar 1kg", "Tea 250g"]
    fnv_items = {"Banana robusta", "Onion 1kg", "Tomato 500g", "Coriander 100g", "Apple shimla 4pc"}
    milk_items = {"Toned milk 500ml", "Curd 400g", "Paneer 200g", "Butter 100g"}

    def item(rng):
        n = rng.choice(names)
        return str(100000 + names.index(n) * 37), f"Sample {n}", n in fnv_items, n in milk_items

    def loc(rng):
        return f"{rng.choice('ABCDEF')}{rng.randint(1, 30):02d}-{rng.randint(1, 6)}-{rng.randint(1, 4)}"

    profiles = {}
    for i, oid in enumerate(ALLOWLIST):
        profiles[oid] = ["broken", "deteriorating", "chronic", "clean", "mid", "clean", "mid", "chronic"][i % 8]

    rs = {k: [] for k in ["loss_daily", "loss_events", "variance_open", "audit_pending", "auditor_quality", "wastage_daily",
                          "wastage_open_tasks", "near_expiry", "complaints_daily", "complaints_open", "forward_open",
                          "forward_dn", "forward_crates", "reverse_open", "loss_central"]}
    auditors_pool = ["Sample Auditor Ravi", "Sample Auditor Neha", "Sample Auditor Aman", "Sample Auditor Pooja", "Sample Auditor Vikas"]

    for oid in ALLOWLIST:
        r = random.Random(args.seed * 100000 + oid)
        prof = profiles[oid]
        base_po, last_po = PROFILES[prof]
        base_orders = r.randint(900, 2700)
        aov = r.uniform(430, 620)
        in_store_boost = 1.25 if prof == "chronic" and oid % 2 else 1.0
        cmp_rate_base = r.uniform(0.6, 1.3)
        cmp_rate_last = cmp_rate_base * (1.9 if prof == "deteriorating" else 1.0)
        if prof == "broken":
            cmp_rate_base, cmp_rate_last = 1.7, 1.8
        daily_comp = {}
        for d in days:
            if d < go_live[oid]:
                continue
            last = d > report - dt.timedelta(days=3)
            orders = int(base_orders * r.uniform(0.9, 1.1))
            c = split_components((last_po if last else base_po) * r.uniform(0.92, 1.08), orders, r, in_store_boost)
            daily_comp[d] = (orders, c)
        # Incidents: a few single events above the incident size, added to that day's component.
        ev_n = 0
        for d in sorted(daily_comp)[-17:]:
            for _ in range(r.randint(0, 2)):
                ev_n += 1
                head, comp = r.choice([("in_store", "bsd"), ("forward", "open_dn_short"), ("reverse", "rsto_total_dump"),
                                       ("returns_refunds", "refund"), ("in_store", "manual_negative")])
                big = r.random() < 0.12
                rupees = round(r.uniform(6000, 22000) if big else r.uniform(300, 3500), 2)
                if big:
                    daily_comp[d][1][comp] = round(daily_comp[d][1][comp] + rupees, 2)
                iid, iname, _f, _m = item(r)
                rs["loss_events"].append({"outlet_id": oid, "dt": d.isoformat(), "event_id": f"EV{oid}{ev_n:04d}", "head": head,
                                          "component": comp, "ref_id": f"REF{r.randint(10000, 99999)}", "item_name": iname, "rupees": rupees})
        if ev_n == 0:
            rs["loss_events"].append({"outlet_id": oid, "dt": None, "event_id": None, "head": None, "component": None,
                                      "ref_id": None, "item_name": None, "rupees": None})
        for d, (orders, c) in sorted(daily_comp.items()):
            gmv = round(orders * aov * r.uniform(0.95, 1.05), 2)
            rs["loss_daily"].append({"outlet_id": oid, "dt": d.isoformat(), "orders": orders, "gmv": gmv, **c})
            sales_fnv, sales_milk = gmv * 0.12, gmv * 0.06
            elig = r.randint(20, 60)
            mark_rate = {"broken": 0.45, "chronic": 0.62}.get(prof, r.uniform(0.6, 0.95))
            nte_c, exp_c = r.randint(5, 20), r.randint(3, 12)
            close_rate = 0.88 if prof == "broken" else r.uniform(0.93, 1.0)
            rs["wastage_daily"].append({
                "outlet_id": oid, "dt": d.isoformat(), "sales_total": gmv, "sales_fnv": round(sales_fnv, 2), "sales_milk": round(sales_milk, 2),
                "dump_total": 0.0, "dump_fnv": round(sales_fnv * r.uniform(0.03, 0.07), 2), "dump_milk": round(sales_milk * r.uniform(0.01, 0.02), 2),
                "dump_lines_eligible": elig, "dump_lines_marked": int(round(elig * min(1.0, mark_rate * r.uniform(0.95, 1.05)))),
                "nte_tasks_created": nte_c, "nte_tasks_closed": int(round(nte_c * min(1.0, close_rate * r.uniform(0.97, 1.03)))),
                "expiry_tasks_created": exp_c, "expiry_tasks_closed": int(round(exp_c * min(1.0, close_rate * r.uniform(0.97, 1.03)))),
                "negative_wastage_lines": 0})
            w = rs["wastage_daily"][-1]
            w["dump_total"] = round(w["dump_fnv"] + w["dump_milk"] + gmv * r.uniform(0.004, 0.01), 2)
            rate = (cmp_rate_last if d > report - dt.timedelta(days=3) else cmp_rate_base) * r.uniform(0.85, 1.15) / 100
            cmpl = int(round(orders * rate))
            parts = {"mdnd": 0.30, "item_missing": 0.25, "item_damaged": 0.15, "item_expired": 0.05, "wrong_item": 0.10, "qng": 0.15}
            row = {"outlet_id": oid, "dt": d.isoformat(), "orders": orders, "complaints": cmpl}
            for k, sh in parts.items():
                row[k] = int(round(cmpl * sh * r.uniform(0.7, 1.3)))
            row["qng_fnv"] = int(round(row["qng"] * r.uniform(0.7, 0.9)))
            rs["complaints_daily"].append(row)

        # Second source: central head-level sheet, MTD, within a few percent of computed.
        mtd = [(o, c) for d, (o, c) in daily_comp.items() if d >= mtd_start]
        o_sum = sum(o for o, _ in mtd)
        csum = {k: sum(c[k] for _, c in mtd) for k in LOSS_COLUMNS}
        heads = {
            "in_store": csum["bsd"] + csum["bse"] + csum["bsnte"] + csum["manual_negative"] - csum["manual_positive"],
            "forward": csum["dn_other"] + csum["nr"] + csum["open_dn_short"] - csum["esto"],
            "reverse": csum["rsto_open_billed"] + csum["rsto_open_dn_short"] + csum["rsto_total_dump"],
            "returns_refunds": csum["refund"] + csum["bad_returns"] + csum["lit"],
        }
        assert abs(sum(heads.values()) - total_by_formula(csum)) < 0.01
        cen = {f"{h}_per_order": round(v / o_sum * r.uniform(0.95, 1.05), 2) for h, v in heads.items()}
        rs["loss_central"].append({"outlet_id": oid, "Total Wastage": round(sum(cen.values()), 2), **cen})

        # Open variance
        n_items = 0 if oid in (6016, 8119) else r.randint(3, 18)
        if prof == "broken":
            n_items += 6
        seen = set()
        for _ in range(n_items):
            iid, iname, fnv, _milk = item(r)
            nl = loc(r)
            if (iid, nl) in seen:
                continue
            seen.add((iid, nl))
            kind = r.random()
            near = r.randint(1, 5) if kind < 0.3 else (0 if kind < 0.75 else None)
            inward = r.randint(1, 4) if 0.3 <= kind < 0.5 else (0 if kind < 0.75 else None)
            if kind >= 0.75:
                near = inward = None
            qty = r.randint(1, 12)
            rs["variance_open"].append({
                "outlet_id": oid, "item_id": iid, "item_name": iname, "is_fnv": int(fnv), "open_qty": qty,
                "open_value": round(qty * r.uniform(30, 260), 2), "negative_location": nl,
                "probable_locations": "; ".join(loc(r) for _ in range(r.randint(1, 2))),
                "last_auditor": r.choice(auditors_pool), "last_audit_ts": (pull_naive - dt.timedelta(hours=r.uniform(4, 240))).isoformat(sep=" ", timespec="minutes"),
                "first_negative_ts": (pull_naive - dt.timedelta(hours=r.uniform(3, 480))).isoformat(sep=" ", timespec="minutes"),
                "nearby_long_qty": near, "nearby_long_locations": loc(r) if near else None, "inward_after_qty": inward})
        if not seen:
            rs["variance_open"].append({"outlet_id": oid, "item_id": None})

        n = r.randint(0, 7)
        for j in range(n):
            iid, iname, _f, _m = item(r)
            created = pull_naive - dt.timedelta(hours=r.uniform(1, 60))
            rs["audit_pending"].append({"outlet_id": oid, "task_id": f"AU{oid}{j:03d}", "audit_type": r.choice(["LOCATION", "ITEM", "EXPIRY"]),
                                        "item_id": iid, "item_name": iname, "location": loc(r),
                                        "assigned_to": r.choice(auditors_pool + [""]),
                                        "created_ts": created.isoformat(sep=" ", timespec="minutes"),
                                        "due_ts": (created + dt.timedelta(hours=12)).isoformat(sep=" ", timespec="minutes")})
        if n == 0:
            rs["audit_pending"].append({"outlet_id": oid, "task_id": None})

        for a in r.sample(auditors_pool, r.randint(2, 4)):
            fast = r.random() < 0.3
            for d in [report - dt.timedelta(days=i) for i in range(6, -1, -1)]:
                if r.random() < 0.2:
                    continue
                units = r.randint(50, 400)
                spu = max(1.5, r.gauss(4.5 if fast else 9.0, 1.5))
                inputs = r.randint(20, 100)
                errs = 0 if r.random() < 0.7 else r.randint(1, 3)
                rs["auditor_quality"].append({"outlet_id": oid, "dt": d.isoformat(), "auditor": a, "units_touched": units,
                                              "audit_seconds": round(units * spu), "inputs_total": inputs,
                                              "inputs_correct": inputs - errs, "min_audit_sec_per_unit": 6.0})

        n = r.randint(0, 9) + (5 if prof == "broken" else 0)
        for j in range(n):
            iid, iname, fnv, milk = item(r)
            q = r.randint(1, 10)
            rs["wastage_open_tasks"].append({"outlet_id": oid, "task_id": f"WT{oid}{j:03d}", "task_type": r.choice(["NTE", "EXPIRY"]),
                                             "item_id": iid, "item_name": iname, "is_fnv": int(fnv), "is_milk": int(milk), "location": loc(r),
                                             "qty": q, "value": round(q * r.uniform(20, 200), 2),
                                             "created_ts": (pull_naive - dt.timedelta(hours=r.uniform(0.5, 30))).isoformat(sep=" ", timespec="minutes"),
                                             "assigned_to": r.choice(["", "Sample Picker Sunil", "Sample Picker Meena"])})
        if n == 0:
            rs["wastage_open_tasks"].append({"outlet_id": oid, "task_id": None})

        n = r.randint(0, 10)
        seen = set()
        for _ in range(n):
            iid, iname, fnv, milk = item(r)
            lc, ex = loc(r), (report + dt.timedelta(days=r.randint(1, 4))).isoformat()
            if (iid, lc, ex) in seen:
                continue
            seen.add((iid, lc, ex))
            q = r.randint(1, 15)
            rs["near_expiry"].append({"outlet_id": oid, "item_id": iid, "item_name": iname, "is_fnv": int(fnv), "is_milk": int(milk),
                                      "location": lc, "qty": q, "value": round(q * r.uniform(20, 180), 2), "expiry_date": ex})
        if not seen:
            rs["near_expiry"].append({"outlet_id": oid, "item_id": None})

        n = r.randint(0, 8)
        types = ["MDND", "ITEM_MISSING", "ITEM_DAMAGED", "ITEM_EXPIRED", "WRONG_ITEM", "QNG"]
        for j in range(n):
            iid, iname, fnv, _m = item(r)
            rs["complaints_open"].append({"outlet_id": oid, "external_complaint_id": f"CMP{oid}{j:04d}", "order_id": f"{r.randint(10**9, 10**10 - 1)}",
                                          "complaint_type": r.choice(types), "item_id": iid, "item_name": iname, "is_fnv": int(fnv),
                                          "picker": r.choice(["Sample Picker Sunil", "Sample Picker Meena", None]),
                                          "created_ts": (pull_naive - dt.timedelta(hours=r.uniform(0.3, 9))).isoformat(sep=" ", timespec="minutes")})
        if n == 0:
            rs["complaints_open"].append({"outlet_id": oid, "external_complaint_id": None})

        n = r.randint(0, 5)
        past6 = 0
        for j in range(n):
            exp = r.randint(200, 1500)
            st = r.choice(["IN_TRANSIT", "ARRIVED", "UNLOADING", "GRN_PENDING", "PUTAWAY_PENDING"])
            unl = 0 if st in ("IN_TRANSIT", "ARRIVED") else int(exp * (r.uniform(0.3, 0.9) if st == "UNLOADING" else 1.0))
            put = int(unl * r.uniform(0.2, 0.9)) if st == "PUTAWAY_PENDING" else 0
            age_h = r.uniform(0.3, 9 if oid % 3 == 0 else 5.5)
            past6 += age_h > 6
            rs["forward_open"].append({"outlet_id": oid, "consignment_id": f"CN{oid}{j:03d}", "source_name": r.choice(["Sample WH Dehradun", "Sample WH Delhi"]),
                                       "status": st, "priority": r.choice(["P0", "P1", "P2"]),
                                       "arrived_ts": (pull_naive - dt.timedelta(hours=age_h)).isoformat(sep=" ", timespec="minutes"),
                                       "units_expected": exp, "units_unloaded": unl, "units_putaway": put,
                                       "grn_pending_units": unl - put if st in ("GRN_PENDING", "PUTAWAY_PENDING") else 0,
                                       "value": round(exp * r.uniform(40, 90), 2)})
        if n == 0:
            rs["forward_open"].append({"outlet_id": oid, "consignment_id": None})

        n = r.randint(0, 12)
        seen = set()
        for j in range(n):
            iid, iname, fnv, _m = item(r)
            cid, t = f"CN{oid}M{r.randint(1, 30):03d}", r.choice(["SHORT", "DAMAGE"])
            if (cid, iid, t) in seen:
                continue
            seen.add((cid, iid, t))
            q = r.randint(1, 20)
            rs["forward_dn"].append({"outlet_id": oid, "dt": (mtd_start + dt.timedelta(days=r.randint(0, (report - mtd_start).days))).isoformat(),
                                     "consignment_id": cid, "dn_type": t, "item_id": iid, "item_name": iname, "is_fnv": int(fnv),
                                     "qty": q, "value": round(q * r.uniform(25, 220), 2)})
        if not seen:
            rs["forward_dn"].append({"outlet_id": oid, "consignment_id": None})

        se = r.randint(200, 800)
        open_dn = round(r.uniform(2000, 15000), 2)
        rs["forward_crates"].append({"outlet_id": oid, "scans_expected": se, "scans_done": int(se * (1.0 if r.random() < 0.5 else r.uniform(0.93, 0.995))),
                                     "crate_attrib_open_dn_value": round(open_dn * r.uniform(0.1, 0.6), 2), "open_dn_value": open_dn,
                                     "crates_0_24h": r.randint(10, 80), "crates_24_48h": r.randint(0, 30), "crates_48_72h": r.randint(0, 12), "crates_72h_plus": r.randint(0, 8)})

        n = r.randint(0, 7)
        for j in range(n):
            v = round(r.uniform(800, 30000), 2)
            rs["reverse_open"].append({"outlet_id": oid, "doc_type": r.choice(["RSTO", "RSTO", "RTS"]), "doc_id": f"RV{oid}{j:03d}",
                                       "state": r.choice(["OPEN_BILLED", "OPEN_DISPATCH", "DN_SHORT"]), "destination": r.choice(["Sample WH Dehradun", "Sample Vendor"]),
                                       "qty": r.randint(5, 300), "value": v, "fnv_value": round(v * r.uniform(0, 0.3), 2),
                                       "created_ts": (pull_naive - dt.timedelta(days=r.uniform(0.5, 15))).isoformat(sep=" ", timespec="minutes")})
        if n == 0:
            rs["reverse_open"].append({"outlet_id": oid, "doc_id": None})

    frames = {k: pd.DataFrame(v) for k, v in rs.items()}
    if args.faults:
        f = frames
        f["complaints_daily"] = f["complaints_daily"][f["complaints_daily"]["outlet_id"] != 7978]
        i = f["wastage_daily"].index[-1]
        f["wastage_daily"].loc[i, "dump_fnv"] = -250.0
        f["wastage_daily"].loc[i, "negative_wastage_lines"] = 2
        f["loss_daily"].loc[f["loss_daily"].index[5], "gmv"] = 0
        f["loss_daily"] = pd.concat([f["loss_daily"], f["loss_daily"].iloc[[10]]])
    for k, df in frames.items():
        df = df.copy()
        if args.faults and k == "near_expiry":
            df["retrieved_at"] = (now - dt.timedelta(hours=30)).isoformat()
        else:
            df["retrieved_at"] = pull_s
        df.to_csv(out / f"{k}.csv", index=False)
    (out / "_SAMPLE").write_text("Generated test data, not real. Written by make_sample_data.py.\n")
    print(f"wrote {len(frames)} result sets and stores.csv to {out}/ (report date {report}{', with faults' if args.faults else ''})")


if __name__ == "__main__":
    main()
