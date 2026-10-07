"""End-to-end and rule checks for generate_uk_sm_dashboard.py on SAMPLE data.

Run: python3 -m pytest -q tests/
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import generate_uk_sm_dashboard as g  # noqa: E402

REPORT_DATE = "2026-10-06"


def run(args, cwd):
    return subprocess.run([sys.executable, str(ROOT / "generate_uk_sm_dashboard.py"), *args],
                          cwd=cwd, capture_output=True, text=True)


def make_sample(dirpath, faults=False):
    cmd = [sys.executable, str(ROOT / "make_sample_data.py"), "--out", str(dirpath), "--report-date", REPORT_DATE]
    if faults:
        cmd.append("--faults")
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True)


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    d = tmp_path_factory.mktemp("sample")
    make_sample(d)
    out = d / "out.html"
    js = d / "payload.json"
    r = run(["--csv-dir", str(d), "--store-master", str(d / "stores.csv"), "--report-date", REPORT_DATE,
             "--out", str(out), "--json-out", str(js)], cwd=d)
    return {"dir": d, "proc": r, "payload": json.loads(js.read_text()), "html": out.read_text()}


def checks_by_name(payload):
    return {c["name"]: c for c in payload["checks"]}


# --- scope and head mapping -------------------------------------------------------------

def test_scope_is_48_in_two_clusters():
    assert len(g.ALLOWLIST) == 48 == len(set(g.ALLOWLIST))
    assert {c: len(v) for c, v in g.CLUSTERS.items()} == {"Dehradun ++": 28, "Haridwar ++": 20}


def test_every_formula_component_in_exactly_one_head():
    assert g.head_mapping_problems() == []
    expected = {
        "in_store": {"bsd", "bse", "bsnte", "manual_negative", "manual_positive"},
        "forward": {"dn_other", "nr", "open_dn_short", "esto"},
        "reverse": {"rsto_open_billed", "rsto_open_dn_short", "rsto_total_dump", "rts_short"},
        "returns_refunds": {"refund", "bad_returns", "lit"},
    }
    assert {k: {c[0] for c in h["components"]} for k, h in g.HEADS.items()} == expected


def test_thresholds_are_the_given_numbers():
    t = g.THRESHOLDS
    assert (t["total"], t["in_store"], t["forward"], t["reverse"], t["returns_refunds"]) == (8.0, 3.5, 1.5, 1.5, 1.5)
    assert (t["open_variance"], t["complaint_pct"], t["nte_expiry_closure_pct"], t["dump_marking_pct"]) == (0.70, 1.5, 95.0, 60.0)
    assert (t["rci_hours"], t["consignment_open_hours"], t["auditor_accuracy_pct"]) == (4.0, 6.0, 100.0)
    assert g.TREND == {"trailing_days": 3, "baseline_days": 14, "rise_pct": 40.0, "min_share_of_threshold_pct": 50.0}


# --- end to end on sample data ----------------------------------------------------------

def test_runs_and_all_checks_pass(sample):
    assert sample["proc"].returncode == 0, sample["proc"].stdout + sample["proc"].stderr
    assert all(c["ok"] for c in sample["payload"]["checks"])
    assert len(sample["payload"]["stores"]) == 48


def test_identity_recomputed_from_raw_csv(sample):
    """Total per order from the literal formula on raw CSV equals the payload total and the sum of heads."""
    raw = pd.read_csv(sample["dir"] / "loss_daily.csv")
    raw["dt"] = pd.to_datetime(raw["dt"]).dt.date
    end = pd.Timestamp(REPORT_DATE).date()
    mtd = raw[(raw["dt"] >= end.replace(day=1)) & (raw["dt"] <= end)]
    for oid, grp in mtd.groupby("outlet_id"):
        c = grp.sum(numeric_only=True)
        total = (c.bsd + c.bse + c.bsnte + (c.manual_negative - c.manual_positive) + c.bad_returns + c.lit
                 + (c.dn_other + c.nr) + c.open_dn_short + c.refund + c.rsto_open_billed + c.rsto_open_dn_short
                 + c.rsto_total_dump - c.esto)
        s = sample["payload"]["stores"][str(oid)]["summary"]
        assert s["orders_mtd"] == pytest.approx(c.orders)
        assert s["total"]["rupees"] == pytest.approx(total, abs=0.01)
        assert s["total"]["per_order"] == pytest.approx(total / c.orders, abs=1e-3)
        h = s["heads"]
        assert h["in_store"]["rupees"] == pytest.approx(c.bsd + c.bse + c.bsnte + c.manual_negative - c.manual_positive, abs=0.01)
        assert h["forward"]["rupees"] == pytest.approx(c.dn_other + c.nr + c.open_dn_short - c.esto, abs=0.01)
        assert h["reverse"]["rupees"] == pytest.approx(c.rsto_open_billed + c.rsto_open_dn_short + c.rsto_total_dump + c.rts_short, abs=0.01)
        assert h["returns_refunds"]["rupees"] == pytest.approx(c.refund + c.bad_returns + c.lit, abs=0.01)
        heads_in_total = sum(x["rupees"] for x in h.values()) - c.rts_short
        assert heads_in_total == pytest.approx(total, abs=0.01)
        assert s["identity"]["ok"]
        assert s["fresh"]["fnv_rupees"] == pytest.approx(c.fnv_loss, abs=0.01)


def test_thresholds_applied_and_higher_source_shown(sample):
    for st in sample["payload"]["stores"].values():
        s = st["summary"]
        for m in [s["total"], *s["heads"].values()]:
            assert m["judged"] >= m["per_order"] - 1e-9
            if m["central_per_order"] is not None:
                assert m["judged"] >= m["central_per_order"] - 1e-9
            assert (m["state"] == "BROKEN") == (round(m["judged"], 2) >= m["threshold"])
            if m["state"] in ("DETERIORATING", "CHRONIC"):
                assert m["judged"] < m["threshold"]
        c = st["complaints"]
        assert (c["state"] == "BROKEN") == (round(c["d1"]["pct"], 2) >= 1.5)
        v = st["variance"]
        assert (v["open_state"] == "BROKEN") == (round(v["open_per_order"], 2) >= 0.70)
        w = st["wastage"]
        assert (w["closure"]["state"] == "BROKEN") == (round(w["closure"]["pct"], 1) < 95.0)
        assert (w["marking"]["state"] == "BROKEN") == (round(w["marking"]["pct"], 1) < 60.0)


def test_cm_grouping_from_master_and_unassigned(sample):
    p = sample["payload"]
    assert p["stores"]["8845"]["cm_status"] == "unassigned"
    assert any(c["cm"] == "CM unassigned" and 8845 in c["stores"] for c in p["cms"])
    assert sum(len(c["stores"]) for c in p["cms"]) == 48
    assert p["stores"]["8845"]["is_new"] and p["stores"]["8896"]["is_new"]


def test_html_is_self_contained(sample):
    h = sample["html"]
    lib = (ROOT / g.ECHARTS_PATH).read_text(encoding="utf-8").replace("</script", "<\\/script")
    assert lib in h, "ECharts not inlined"
    ours = h.replace(lib, "")  # the page without the vendored library (its locale strings are not ours)
    assert ("<script src" in h) is False
    assert ("<link" in h) is False
    assert (chr(0x2014) in ours) is False, "em dash in page text"
    assert ("http://" in ours or "https://" in ours) is False, "external URL in page"
    assert ("SAMPLE DATA" in h) is True


def test_complaint_numerator_is_distinct():
    sql = (ROOT / "queries" / "complaints_daily.sql").read_text().split("*/", 1)[1].lower()
    assert "count(distinct external_complaint_id)" in sql
    assert not re.search(r"count\(\s*external_complaint_id", sql)
    assert "count(*)" not in sql


# --- control strip catches faults -------------------------------------------------------

def test_faults_are_caught(tmp_path):
    make_sample(tmp_path, faults=True)
    js = tmp_path / "p.json"
    r = run(["--csv-dir", str(tmp_path), "--store-master", str(tmp_path / "stores.csv"), "--report-date", REPORT_DATE,
             "--out", str(tmp_path / "o.html"), "--json-out", str(js)], cwd=tmp_path)
    assert r.returncode == 2
    p = json.loads(js.read_text())
    failing = {c["name"]: c["detail"] for c in p["checks"] if not c["ok"]}
    assert any("complaints_daily" in d and "7978" in d for d in failing["Every allowlist outlet present in each result set"])
    assert failing["No negative wastage (data integrity)"]
    assert failing["No day with orders > 0 and GMV zero"]
    assert any(d.startswith("loss_daily") for d in failing["No duplicate store rows"])
    assert any("near_expiry" in d and "STALE" in d for d in failing["Freshness of each query"])
    st = p["stores"]["7978"]
    assert st["complaints"]["daily_status"] == "absent"
    assert any(e["state"] == "NO_DATA" and e["metric"] == "complaints_daily" for e in st["exceptions"])
    cm_order = next(c["stores"] for c in p["cms"] if 7978 in c["stores"])
    assert cm_order.index(7978) < len(cm_order)


def test_pending_access_is_greyed_not_omitted(tmp_path):
    make_sample(tmp_path)
    (tmp_path / "reverse_open.csv").unlink()
    js = tmp_path / "p.json"
    r = run(["--csv-dir", str(tmp_path), "--store-master", str(tmp_path / "stores.csv"), "--report-date", REPORT_DATE,
             "--out", str(tmp_path / "o.html"), "--json-out", str(js)], cwd=tmp_path)
    p = json.loads(js.read_text())
    assert p["sources"]["reverse_open"]["status"] == "pending_access"
    assert all(s["reverse"]["open_status"] == "pending_access" for s in p["stores"].values())
    assert r.returncode == 2
    assert "Source pending access" in (tmp_path / "o.html").read_text()


def test_missing_store_master_is_flagged(tmp_path):
    make_sample(tmp_path)
    data = tmp_path / "data"
    data.mkdir()
    for f in tmp_path.glob("*.csv"):
        if f.name != "stores.csv":
            shutil.copy(f, data / f.name)
    shutil.copy(tmp_path / "_SAMPLE", data / "_SAMPLE")
    js = tmp_path / "p.json"
    r = run(["--csv-dir", str(data), "--report-date", REPORT_DATE, "--out", str(tmp_path / "o.html"),
             "--json-out", str(js), "--store-master", str(tmp_path / "nope.csv")], cwd=tmp_path)
    p = json.loads(js.read_text())
    assert r.returncode == 2
    assert all(s["cm_status"] == "master_missing" for s in p["stores"].values())
    assert not checks_by_name(p)["Store master covers all 48 outlets"]["ok"]


# --- units ------------------------------------------------------------------------------

def test_state_rules():
    assert g.loss_state(8.0, 8.0, 1, 1)[0] == "BROKEN"
    assert g.loss_state(7.999, 8.0, 1, 1)[0] == "BROKEN"  # rounds to 8.00 as displayed
    assert g.loss_state(6.0, 8.0, 7.0, 4.0) == ("DETERIORATING", "up")   # +75%, trailing >= 4.0
    assert g.loss_state(3.5, 8.0, 3.9, 2.0)[0] == "CLEAN"                # rising but under 50% of threshold
    assert g.loss_state(5.5, 8.0, 5.6, 5.4) == ("CHRONIC", "flat")
    assert g.loss_state(2.0, 8.0, 2.0, 2.0) == ("CLEAN", "flat")
    assert g.loss_state(5.0, 8.0, None, 4.0) == ("CLEAN", None)          # trend not computable: no deteriorating claim
    assert g.loss_state(None, 8.0, 1, 1)[0] == "NO_DATA"


def test_variance_discriminator_only_where_supported():
    assert g.classify_variance({"nearby_long_qty": 3, "inward_after_qty": 0})[0] == "MATCHED"
    assert g.classify_variance({"nearby_long_qty": 0, "inward_after_qty": 2})[0] == "CORRECTION"
    assert g.classify_variance({"nearby_long_qty": 0, "inward_after_qty": 0})[0] == "UNMATCHED"
    assert g.classify_variance({"nearby_long_qty": None, "inward_after_qty": 0})[0] == "UNCLASSIFIED"
    assert g.classify_variance({"nearby_long_qty": None, "inward_after_qty": None})[0] == "UNCLASSIFIED"


def test_sql_rules():
    allow = set(g.ALLOWLIST)
    for f in sorted((ROOT / "queries").glob("*.sql")):
        head, body = f.read_text().split("*/", 1)
        for key in ("STATUS: UNVALIDATED", "GRAIN:", "NUMERATOR:", "DENOMINATOR:", "SOURCE TABLES:"):
            assert key in head, f"{f.name}: header missing {key}"
        body = body.strip()
        assert not body.endswith(";"), f"{f.name}: trailing semicolon"
        assert "--" not in body and "/*" not in body, f"{f.name}: inline comment"
        m = re.search(r"unnest\(array\[([^\]]+)\]\)", body)
        assert m, f"{f.name}: no unnest scope"
        assert {int(x) for x in m.group(1).split(",")} == allow, f"{f.name}: scope differs from CONFIG"
        assert len(m.group(1).split(",")) == 48
        assert "city" not in body.lower() and "business_type" not in body.lower()
        assert "at time zone 'asia/kolkata'" in body.lower(), f"{f.name}: window not anchored on IST date"
