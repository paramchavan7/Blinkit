#!/usr/bin/env python3
"""Generate "Dashboard - UK SM Worklist.html" for the 48 Uttarakhand (UK) dark stores.

One self-contained HTML file: opens offline by double-click, ECharts inlined, no CDN,
no external fonts. Store selector, worklist first, one tab per charter.

Run (Redash mode, reads REDASH_URL and REDASH_API_KEY from the environment):
    python3 generate_uk_sm_dashboard.py

Run (CSV mode, one <charter_key>.csv per result set, for sheet exports):
    python3 generate_uk_sm_dashboard.py --csv-dir exports/

See README.md for the CONFIG block, the result-set contracts and how to add a query.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

# =====================================================================================
# CONFIG
# Every number below is either one you gave (thresholds, trend defaults, scope) or is
# marked "author default, confirm" where you gave none. Change values here only.
# =====================================================================================

# Scope. Explicit outlet_id allowlist. Never filter by city string or business_type.
CLUSTERS = {
    "Dehradun ++": [4073, 4074, 4071, 3577, 3171, 5040, 5401, 4935, 4933, 6016, 6018, 6342, 6474, 7076,
                    6826, 7251, 7160, 7701, 7690, 8261, 7972, 8058, 8505, 8436, 8554, 8453, 8461, 7978],
    "Haridwar ++": [4777, 4745, 4825, 6187, 6462, 6719, 6471, 6506, 7162, 7159, 6910, 7779, 7877, 8191,
                    8408, 8119, 8490, 8681, 8896, 8845],
}
EXPECTED_STORE_COUNT = 48
EXPECTED_CLUSTER_COUNTS = {"Dehradun ++": 28, "Haridwar ++": 20}

# Store master: store name, CM, go-live date, type, mode. Looked up in this order unless
# --store-master is passed. CM always comes from here, never from city or cluster.
STORE_MASTER_CANDIDATES = ["stores.csv", "store-master.md"]
NEW_STORE_DAYS = 60  # stores younger than this from go-live get the noisy-store glyph

# Per-order denominator. Three delivered-order definitions exist; this names the one used.
DENOMINATOR = {
    "column": "orders",
    "short": "delivered orders",
    "definition": ("UNCONFIRMED. Distinct orders delivered on the IST day, as written in "
                   "queries/loss_daily.sql. Three delivered-order definitions exist; set the one "
                   "you are judged on here and in the query."),
    "source": "dwh.fact_sales_order_details (table and filter UNVALIDATED)",
}

# Thresholds (yours). Loss figures are rupees per delivered order.
THRESHOLDS = {
    "total": 8.0,
    "in_store": 3.5,
    "forward": 1.5,
    "reverse": 1.5,
    "returns_refunds": 1.5,
    "open_variance": 0.70,
    "complaint_pct": 1.5,
    "nte_expiry_closure_pct": 95.0,   # floor
    "dump_marking_pct": 60.0,         # floor
    "auditor_accuracy_pct": 100.0,    # target
    "rci_hours": 4.0,
    "consignment_open_hours": 6.0,
}

# Store state trend parameters. Heuristic, uncalibrated. Shown on the page as such.
TREND = {
    "trailing_days": 3,
    "baseline_days": 14,
    "rise_pct": 40.0,
    "min_share_of_threshold_pct": 50.0,
}
# Single loss events at or above this rupee size are excluded from the trend and listed as
# incidents. Author default, confirm (you gave no value). None switches exclusion off.
INCIDENT_MIN_RUPEES = 5000

# Minimum-audit-time line, seconds per unit touched. You gave no value: None means the line
# is taken from the auditor_quality column min_audit_sec_per_unit if present, else not drawn.
MIN_AUDIT_SEC_PER_UNIT = None

# Crate attributable OpenDN preconditions. "About 100 percent" scanning adherence:
# author default 99.0, confirm.
CRATE_SCAN_ADHERENCE_MIN_PCT = 99.0

# Freshness. A result older than this (hours, at generation time) is marked stale.
# Author default, confirm. Per-query override via QUERIES[key]["stale_hours"].
STALENESS_LIMIT_HOURS = 6.0

# Redash. URL and key come from REDASH_URL and REDASH_API_KEY, never from this file.
# max_age makes Redash return its last stored result instead of re-running the query.
REDASH_MAX_AGE_SECONDS = 7 * 24 * 3600
REDASH_JOB_TIMEOUT_SECONDS = 600

# Charter key -> Redash query. id None means "not set yet" (the section shows as missing).
# pending_access True means the source is known to be access-denied: it is not fetched and
# its section is greyed "source pending access". columns renames source columns to the
# contract names in RESULT_SETS (use it to plug in an existing query without editing it).
QUERIES = {
    "loss_daily":         {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "loss_events":        {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "loss_central":       {"id": None, "params": {}, "pending_access": False, "stale_hours": None,
                           "columns": {"Total Wastage": "total_per_order"}},
    "variance_open":      {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "audit_pending":      {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "auditor_quality":    {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "wastage_daily":      {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "wastage_open_tasks": {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "near_expiry":        {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "complaints_daily":   {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "complaints_open":    {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "forward_open":       {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "forward_dn":         {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "forward_crates":     {"id": None, "params": {}, "pending_access": False, "stale_hours": None, "columns": {}},
    "reverse_open":       {"id": None, "params": {}, "pending_access": True,  "stale_hours": None, "columns": {}},
}

# Head assignment. Each component of the confirmed total formula sits in exactly one head.
# (column, sign, status, in_total). status is "confirmed" or "inferred" and is printed on the
# page. in_total False means the component belongs to the head but not to the total formula.
HEADS = {
    "in_store": {
        "label": "In-store", "tab": "variance",
        "components": [
            ("bsd", +1, "confirmed", True),
            ("bse", +1, "confirmed", True),
            ("bsnte", +1, "confirmed", True),
            ("manual_negative", +1, "confirmed", True),
            ("manual_positive", -1, "confirmed", True),
        ],
    },
    "forward": {
        "label": "Forward", "tab": "forward",
        "components": [
            ("dn_other", +1, "confirmed", True),
            ("nr", +1, "confirmed", True),
            ("open_dn_short", +1, "confirmed", True),
            ("esto", -1, "confirmed", True),
        ],
    },
    "reverse": {
        "label": "Reverse", "tab": "reverse",
        "components": [
            ("rsto_open_billed", +1, "inferred", True),
            ("rsto_open_dn_short", +1, "inferred", True),
            ("rsto_total_dump", +1, "inferred", True),
            ("rts_short", +1, "inferred", False),
        ],
    },
    "returns_refunds": {
        "label": "Returns and refunds", "tab": "complaints",
        "components": [
            ("refund", +1, "confirmed", True),
            ("bad_returns", +1, "confirmed", True),
            ("lit", +1, "confirmed", True),
        ],
    },
}

# Report window end. None means yesterday in IST (current_date - 1 day, IST).
REPORT_DATE = None
SPARK_DAYS = 30
OUTPUT_FILENAME = "Dashboard - UK SM Worklist.html"
ECHARTS_PATH = "vendor/echarts-5.5.1.min.js"

# =====================================================================================
# END CONFIG
# =====================================================================================

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
ALLOWLIST = [o for c in CLUSTERS.values() for o in c]
CLUSTER_OF = {o: c for c, lst in CLUSTERS.items() for o in lst}

COMPONENT_LABELS = {
    "bsd": "BSD", "bse": "BSE", "bsnte": "BSNTE",
    "manual_negative": "Manual negative", "manual_positive": "Manual positive (credit)",
    "bad_returns": "Bad returns", "lit": "LIT", "dn_other": "DN other", "nr": "NR",
    "open_dn_short": "Open DN short", "refund": "Refund",
    "rsto_open_billed": "RSTO open billed", "rsto_open_dn_short": "RSTO open DN short",
    "rsto_total_dump": "RSTO total dump", "esto": "ESTO (credit)", "rts_short": "RTS short",
    "crwi": "CRWI", "fwd_in_transit": "Forward in transit", "fnv_loss": "FNV", "milk_loss": "Milk",
}

LOSS_COLUMNS = ["bsd", "bse", "bsnte", "manual_negative", "manual_positive", "bad_returns", "lit",
                "dn_other", "nr", "open_dn_short", "refund", "rsto_open_billed", "rsto_open_dn_short",
                "rsto_total_dump", "esto", "rts_short", "crwi", "fwd_in_transit", "fnv_loss", "milk_loss"]

# Result-set contracts. kind: daily (outlet x day), store (one row per outlet), list (open items;
# a row with a null row_key is a coverage row meaning "outlet covered, zero items").
RESULT_SETS = {
    "loss_daily": {
        "charter": "summary", "kind": "daily", "key": ["outlet_id", "dt"],
        "required": ["outlet_id", "dt", "orders", "gmv"] + LOSS_COLUMNS,
        "numeric": ["orders", "gmv"] + LOSS_COLUMNS, "dates": ["dt"], "ts": [],
    },
    "loss_events": {
        "charter": "summary", "kind": "list", "row_key": "event_id", "key": ["outlet_id", "event_id"],
        "required": ["outlet_id", "dt", "event_id", "head", "component", "ref_id", "item_name", "rupees"],
        "numeric": ["rupees"], "dates": ["dt"], "ts": [],
    },
    "loss_central": {
        "charter": "summary", "kind": "store", "key": ["outlet_id"], "optional_source": True,
        "required": ["outlet_id", "total_per_order", "in_store_per_order", "forward_per_order",
                     "reverse_per_order", "returns_refunds_per_order"],
        "numeric": ["total_per_order", "in_store_per_order", "forward_per_order", "reverse_per_order",
                    "returns_refunds_per_order"], "dates": [], "ts": [],
    },
    "variance_open": {
        "charter": "variance", "kind": "list", "row_key": "item_id",
        "key": ["outlet_id", "item_id", "negative_location"],
        "required": ["outlet_id", "item_id", "item_name", "is_fnv", "open_qty", "open_value",
                     "negative_location", "probable_locations", "last_auditor", "last_audit_ts",
                     "first_negative_ts", "nearby_long_qty", "nearby_long_locations", "inward_after_qty"],
        "numeric": ["open_qty", "open_value", "nearby_long_qty", "inward_after_qty"], "dates": [],
        "ts": ["last_audit_ts", "first_negative_ts"],
    },
    "audit_pending": {
        "charter": "variance", "kind": "list", "row_key": "task_id", "key": ["outlet_id", "task_id"],
        "required": ["outlet_id", "task_id", "audit_type", "item_id", "item_name", "location",
                     "assigned_to", "created_ts", "due_ts"],
        "numeric": [], "dates": [], "ts": ["created_ts", "due_ts"],
    },
    "auditor_quality": {
        "charter": "variance", "kind": "list", "row_key": "auditor", "key": ["outlet_id", "dt", "auditor"],
        "required": ["outlet_id", "dt", "auditor", "units_touched", "audit_seconds", "inputs_total",
                     "inputs_correct"],
        "numeric": ["units_touched", "audit_seconds", "inputs_total", "inputs_correct",
                    "min_audit_sec_per_unit"], "dates": ["dt"], "ts": [],
    },
    "wastage_daily": {
        "charter": "wastage", "kind": "daily", "key": ["outlet_id", "dt"],
        "required": ["outlet_id", "dt", "sales_total", "sales_fnv", "sales_milk", "dump_total", "dump_fnv",
                     "dump_milk", "dump_lines_eligible", "dump_lines_marked", "nte_tasks_created",
                     "nte_tasks_closed", "expiry_tasks_created", "expiry_tasks_closed",
                     "negative_wastage_lines"],
        "numeric": ["sales_total", "sales_fnv", "sales_milk", "dump_total", "dump_fnv", "dump_milk",
                    "dump_lines_eligible", "dump_lines_marked", "nte_tasks_created", "nte_tasks_closed",
                    "expiry_tasks_created", "expiry_tasks_closed", "negative_wastage_lines"],
        "dates": ["dt"], "ts": [],
    },
    "wastage_open_tasks": {
        "charter": "wastage", "kind": "list", "row_key": "task_id", "key": ["outlet_id", "task_id"],
        "required": ["outlet_id", "task_id", "task_type", "item_id", "item_name", "is_fnv", "is_milk",
                     "location", "qty", "value", "created_ts", "assigned_to"],
        "numeric": ["qty", "value"], "dates": [], "ts": ["created_ts"],
    },
    "near_expiry": {
        "charter": "wastage", "kind": "list", "row_key": "item_id",
        "key": ["outlet_id", "item_id", "location", "expiry_date"],
        "required": ["outlet_id", "item_id", "item_name", "is_fnv", "is_milk", "location", "qty", "value",
                     "expiry_date"],
        "numeric": ["qty", "value"], "dates": ["expiry_date"], "ts": [],
    },
    "complaints_daily": {
        "charter": "complaints", "kind": "daily", "key": ["outlet_id", "dt"],
        "required": ["outlet_id", "dt", "orders", "complaints", "mdnd", "item_missing", "item_damaged",
                     "item_expired", "wrong_item", "qng", "qng_fnv"],
        "numeric": ["orders", "complaints", "mdnd", "item_missing", "item_damaged", "item_expired",
                    "wrong_item", "qng", "qng_fnv"], "dates": ["dt"], "ts": [],
    },
    "complaints_open": {
        "charter": "complaints", "kind": "list", "row_key": "external_complaint_id",
        "key": ["outlet_id", "external_complaint_id"],
        "required": ["outlet_id", "external_complaint_id", "order_id", "complaint_type", "item_id",
                     "item_name", "is_fnv", "picker", "created_ts"],
        "numeric": [], "dates": [], "ts": ["created_ts"],
    },
    "forward_open": {
        "charter": "forward", "kind": "list", "row_key": "consignment_id", "key": ["outlet_id", "consignment_id"],
        "required": ["outlet_id", "consignment_id", "source_name", "status", "priority", "arrived_ts",
                     "units_expected", "units_unloaded", "units_putaway", "grn_pending_units", "value"],
        "numeric": ["units_expected", "units_unloaded", "units_putaway", "grn_pending_units", "value"],
        "dates": [], "ts": ["arrived_ts"],
    },
    "forward_dn": {
        "charter": "forward", "kind": "list", "row_key": "consignment_id",
        "key": ["outlet_id", "consignment_id", "item_id", "dn_type"],
        "required": ["outlet_id", "dt", "consignment_id", "dn_type", "item_id", "item_name", "is_fnv", "qty",
                     "value"],
        "numeric": ["qty", "value"], "dates": ["dt"], "ts": [],
    },
    "forward_crates": {
        "charter": "forward", "kind": "store", "key": ["outlet_id"],
        "required": ["outlet_id", "scans_expected", "scans_done", "crate_attrib_open_dn_value",
                     "open_dn_value", "crates_0_24h", "crates_24_48h", "crates_48_72h", "crates_72h_plus"],
        "numeric": ["scans_expected", "scans_done", "crate_attrib_open_dn_value", "open_dn_value",
                    "crates_0_24h", "crates_24_48h", "crates_48_72h", "crates_72h_plus"],
        "dates": [], "ts": [],
    },
    "reverse_open": {
        "charter": "reverse", "kind": "list", "row_key": "doc_id", "key": ["outlet_id", "doc_type", "doc_id", "state"],
        "required": ["outlet_id", "doc_type", "doc_id", "state", "destination", "qty", "value", "fnv_value",
                     "created_ts"],
        "numeric": ["qty", "value", "fnv_value"], "dates": [], "ts": ["created_ts"],
    },
}

SOURCE_LABELS = {
    "loss_daily": "Loss components by store and day",
    "loss_events": "Single loss events (incidents)",
    "loss_central": "Central head-level sheet (second source)",
    "variance_open": "Open variance by item",
    "audit_pending": "Pending audits",
    "auditor_quality": "Auditor quality",
    "wastage_daily": "Dump, sales, marking and task closure by day",
    "wastage_open_tasks": "Open NTE and expiry tasks",
    "near_expiry": "Near-expiry items not actioned",
    "complaints_daily": "Complaints by store and day",
    "complaints_open": "Open complaints",
    "forward_open": "Open forward consignments",
    "forward_dn": "DN short and damage lines",
    "forward_crates": "Crate scanning and crate age",
    "reverse_open": "Open RSTO and RTS documents",
}

UNASSIGNED_CM_VALUES = {"", "na", "n/a", "-", "tbd", "tba", "unassigned", "none", "null", "nan", "cm unassigned"}


# -------------------------------------------------------------------------------------
# Small helpers
# -------------------------------------------------------------------------------------

def num(x):
    """Float or None. Never turns a missing value into zero."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def div(a, b):
    a, b = num(a), num(b)
    if a is None or b is None or b == 0:
        return None
    return a / b


def text(x):
    if x is None:
        return None
    if isinstance(x, float) and math.isnan(x):
        return None
    s = str(x).strip()
    return s if s and s.lower() not in ("nan", "none", "null", "nat") else None


def truthy(x):
    s = text(x)
    if s is None:
        return False
    if s.lower() in ("true", "t", "y", "yes"):
        return True
    try:
        return float(s) != 0
    except ValueError:
        return False


def iso(ts):
    if ts is None or (isinstance(ts, float) and math.isnan(ts)):
        return None
    if isinstance(ts, pd.Timestamp):
        if pd.isna(ts):
            return None
        ts = ts.to_pydatetime()
    if isinstance(ts, dt.datetime):
        return ts.strftime("%Y-%m-%d %H:%M")
    if isinstance(ts, dt.date):
        return ts.isoformat()
    return str(ts)


def clean_json(obj):
    if isinstance(obj, dict):
        return {str(k): clean_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_json(v) for v in obj]
    if isinstance(obj, float):
        return None if math.isnan(obj) or math.isinf(obj) else round(obj, 4)
    if isinstance(obj, (pd.Timestamp, dt.datetime, dt.date)):
        return iso(obj)
    if hasattr(obj, "item"):
        return clean_json(obj.item())
    return obj


def norm_header(h):
    return re.sub(r"[\s_\-]+", " ", str(h).strip().lower())


def fmt_rs(x):
    if x is None:
        return "-"
    neg = x < 0
    s = f"{abs(x):,.0f}"
    # Indian grouping
    whole = s.replace(",", "")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        head = ",".join([head[max(0, i - 2):i] for i in range(len(head), 0, -2)][::-1])
        s = head + "," + tail
    return ("-" if neg else "") + "Rs " + s


# -------------------------------------------------------------------------------------
# Store master
# -------------------------------------------------------------------------------------

MASTER_ALIASES = {
    "outlet_id": ["outlet id", "outletid", "outlet", "store id", "store outlet id"],
    "store_name": ["store name", "name", "outlet name", "store", "store outlet name"],
    "cm": ["cm", "cm name", "cluster manager", "cluster manager name"],
    "go_live": ["go live", "go live date", "golive", "golive date", "live date", "launch date", "go-live"],
    "type": ["type", "store type", "outlet type"],
    "mode": ["mode", "store mode", "operating mode", "ops mode"],
}


def _read_md_table(path):
    rows, header = [], None
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            if header is not None and rows:
                break
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        if header is None:
            header = cells
        else:
            rows.append(cells + [""] * (len(header) - len(cells)))
    if header is None:
        raise ValueError(f"no markdown table found in {path}")
    return pd.DataFrame([r[: len(header)] for r in rows], columns=header)


def _parse_date(s):
    s = text(s)
    if s is None:
        return None
    for f in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d %b %Y", "%d-%b-%Y", "%d-%b-%y", "%d %B %Y",
              "%Y/%m/%d", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            pass
    return None


def load_store_master(path_arg, search_dirs):
    candidates = [Path(path_arg)] if path_arg else [Path(d) / c for d in dict.fromkeys(search_dirs) for c in STORE_MASTER_CANDIDATES]
    path = next((p for p in candidates if p.exists()), None)
    result = {"path": str(path) if path else None, "stores": {}, "notes": []}
    if path is None:
        result["notes"].append("store master not found (looked for: " + ", ".join(str(c) for c in candidates) + ")")
        return result
    df = _read_md_table(path) if path.suffix.lower() == ".md" else pd.read_csv(path, dtype=str)
    cols = {norm_header(c): c for c in df.columns}
    mapped = {}
    for target, aliases in MASTER_ALIASES.items():
        for a in [target.replace("_", " ")] + aliases:
            if norm_header(a) in cols:
                mapped[target] = cols[norm_header(a)]
                break
    if "outlet_id" not in mapped:
        result["notes"].append(f"store master {path.name} has no outlet_id column; columns: {list(df.columns)}")
        return result
    for _, r in df.iterrows():
        oid_s = re.sub(r"\D", "", str(r[mapped["outlet_id"]]))
        if not oid_s:
            continue
        oid = int(oid_s)
        if oid not in CLUSTER_OF:
            continue
        rec = {k: text(r[c]) for k, c in mapped.items() if k != "outlet_id"}
        gl_raw = rec.get("go_live")
        rec["go_live"] = _parse_date(gl_raw)
        if gl_raw and rec["go_live"] is None:
            result["notes"].append(f"outlet {oid}: go-live '{gl_raw}' not parsed")
        if oid in result["stores"]:
            result["notes"].append(f"outlet {oid} appears more than once in the store master; first row kept")
            continue
        result["stores"][oid] = rec
    return result


# -------------------------------------------------------------------------------------
# Result sets: CSV and Redash loaders
# -------------------------------------------------------------------------------------

@dataclass
class Source:
    key: str
    status: str = "missing"          # ok | missing | not_configured | pending_access | error
    df: pd.DataFrame | None = None
    retrieved_at: dt.datetime | None = None   # aware, IST
    retrieved_note: str = ""
    error: str = ""
    origin: str = ""
    dropped_out_of_scope: list = field(default_factory=list)
    unparsed: dict = field(default_factory=dict)

    @property
    def ok(self):
        return self.status == "ok"


ACCESS_DENIED_RE = re.compile(r"access denied|permission|not authori[sz]ed|forbidden|insufficient privileges", re.I)


def _parse_retrieved(series_or_value):
    try:
        ts = pd.to_datetime(series_or_value, errors="coerce")
    except Exception:
        return None
    if isinstance(ts, pd.Series):
        ts = ts.dropna()
        if ts.empty:
            return None
        ts = ts.max()
    if ts is None or pd.isna(ts):
        return None
    ts = ts.to_pydatetime()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=IST)
    return ts.astimezone(IST)


def load_csv_source(key, csv_dir):
    src = Source(key=key, origin="csv")
    path = Path(csv_dir) / f"{key}.csv"
    cfg = QUERIES.get(key, {})
    if not path.exists():
        src.status = "pending_access" if cfg.get("pending_access") else "missing"
        src.error = f"{path.name} not found in {csv_dir}"
        return src
    try:
        df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=["", "NULL", "null", "None", "nan", "NaN"])
    except Exception as e:  # noqa: BLE001
        src.status, src.error = "error", f"could not read {path.name}: {e}"
        return src
    if "retrieved_at" in df.columns:
        src.retrieved_at = _parse_retrieved(df["retrieved_at"])
        src.retrieved_note = "retrieved_at column in export"
        df = df.drop(columns=["retrieved_at"])
    if src.retrieved_at is None:
        src.retrieved_at = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=IST)
        src.retrieved_note = "file modified time (export time unknown)"
    src.df = df
    src.status = "ok"
    return src


def load_redash_source(key, session, base_url, max_age):
    import requests  # noqa: F401  (only needed in Redash mode)

    src = Source(key=key, origin="redash")
    cfg = QUERIES[key]
    if cfg.get("pending_access"):
        src.status, src.error = "pending_access", "marked pending_access in CONFIG; not fetched"
        return src
    if cfg.get("id") is None:
        src.status, src.error = "not_configured", "no Redash query id in CONFIG QUERIES"
        return src
    qid = cfg["id"]
    try:
        r = session.post(f"{base_url}/api/queries/{qid}/results",
                         json={"parameters": cfg.get("params") or {}, "max_age": max_age}, timeout=60)
        if r.status_code == 403:
            src.status, src.error = "pending_access", f"HTTP 403 from Redash for query {qid}"
            return src
        r.raise_for_status()
        payload = r.json()
        if "job" in payload and "query_result" not in payload:
            job = payload["job"]
            deadline = time.time() + REDASH_JOB_TIMEOUT_SECONDS
            while job.get("status") not in (3, 4):
                if time.time() > deadline:
                    raise TimeoutError(f"Redash job for query {qid} did not finish in {REDASH_JOB_TIMEOUT_SECONDS}s")
                time.sleep(2)
                job = session.get(f"{base_url}/api/jobs/{job['id']}", timeout=60).json()["job"]
            if job.get("status") == 4:
                msg = str(job.get("error", "Redash job failed"))
                src.status = "pending_access" if ACCESS_DENIED_RE.search(msg) else "error"
                src.error = msg[:500]
                return src
            r = session.get(f"{base_url}/api/query_results/{job['query_result_id']}", timeout=120)
            r.raise_for_status()
            payload = r.json()
        qr = payload["query_result"]
        cols = [c["name"] for c in qr["data"]["columns"]]
        df = pd.DataFrame(qr["data"]["rows"], columns=cols).astype(object)
        df = df.where(pd.notna(df), None)
        df = df.map(lambda v: None if v is None else str(v))
        src.df = df
        src.retrieved_at = _parse_retrieved(qr.get("retrieved_at"))
        src.retrieved_note = f"Redash query {qid}, result {qr.get('id')}"
        src.status = "ok"
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        src.status = "pending_access" if ACCESS_DENIED_RE.search(msg) else "error"
        src.error = msg[:500]
    return src


def normalise_source(src):
    """Rename to contract columns, check required columns, coerce types, drop out-of-scope outlets."""
    if not src.ok:
        return src
    spec = RESULT_SETS[src.key]
    aliases = QUERIES.get(src.key, {}).get("columns") or {}
    df = src.df.rename(columns={k: v for k, v in aliases.items() if k in src.df.columns})
    df.columns = [str(c).strip().lower() for c in df.columns]
    missing = [c for c in spec["required"] if c not in df.columns]
    if missing:
        src.status = "error"
        src.error = f"missing required columns: {', '.join(missing)}"
        src.df = None
        return src
    oid = pd.to_numeric(df["outlet_id"].astype(str).str.replace(r"\.0$", "", regex=True), errors="coerce")
    bad = int(oid.isna().sum())
    if bad:
        src.unparsed["outlet_id"] = bad
    df = df.assign(outlet_id=oid).dropna(subset=["outlet_id"])
    df["outlet_id"] = df["outlet_id"].astype(int)
    out = sorted(set(df.loc[~df["outlet_id"].isin(ALLOWLIST), "outlet_id"].tolist()))
    src.dropped_out_of_scope = out
    df = df[df["outlet_id"].isin(ALLOWLIST)].copy()
    for c in spec["numeric"]:
        if c in df.columns:
            raw = df[c]
            conv = pd.to_numeric(raw, errors="coerce")
            n_bad = int((conv.isna() & raw.notna()).sum())
            if n_bad:
                src.unparsed[c] = n_bad
            df[c] = conv
    for c in spec["dates"]:
        conv = pd.to_datetime(df[c], errors="coerce")
        n_bad = int((conv.isna() & df[c].notna()).sum())
        if n_bad:
            src.unparsed[c] = n_bad
        df[c] = conv.dt.date
    for c in spec["ts"]:
        conv = pd.to_datetime(df[c], errors="coerce")
        if getattr(conv.dt, "tz", None) is not None:
            conv = conv.dt.tz_convert(IST).dt.tz_localize(None)
        n_bad = int((conv.isna() & df[c].notna()).sum())
        if n_bad:
            src.unparsed[c] = n_bad
        df[c] = conv
    src.df = df.reset_index(drop=True)
    return src


def load_sources(args, base_dir):
    sources = {}
    if args.csv_dir:
        for key in RESULT_SETS:
            sources[key] = normalise_source(load_csv_source(key, args.csv_dir))
        return sources
    base_url = os.environ.get("REDASH_URL", "").rstrip("/")
    api_key = os.environ.get("REDASH_API_KEY", "")
    if not base_url or not api_key:
        sys.exit("REDASH_URL and REDASH_API_KEY must be set (or use --csv-dir).")
    import requests

    session = requests.Session()
    session.headers["Authorization"] = f"Key {api_key}"
    max_age = 0 if args.refresh else REDASH_MAX_AGE_SECONDS
    for key in RESULT_SETS:
        sources[key] = normalise_source(load_redash_source(key, session, base_url, max_age))
    return sources


# -------------------------------------------------------------------------------------
# Windows and state
# -------------------------------------------------------------------------------------

@dataclass
class Windows:
    report_date: dt.date
    mtd_start: dt.date
    trailing_start: dt.date
    baseline_start: dt.date
    baseline_end: dt.date
    spark_start: dt.date

    @classmethod
    def build(cls, report_date):
        t, b = TREND["trailing_days"], TREND["baseline_days"]
        trailing_start = report_date - dt.timedelta(days=t - 1)
        baseline_end = trailing_start - dt.timedelta(days=1)
        return cls(report_date=report_date, mtd_start=report_date.replace(day=1),
                   trailing_start=trailing_start, baseline_start=baseline_end - dt.timedelta(days=b - 1),
                   baseline_end=baseline_end, spark_start=report_date - dt.timedelta(days=SPARK_DAYS - 1))

    def days(self, a, b):
        return [a + dt.timedelta(days=i) for i in range((b - a).days + 1)]

    def as_dict(self):
        return {"report_date": self.report_date, "mtd_start": self.mtd_start,
                "trailing_start": self.trailing_start, "trailing_end": self.report_date,
                "baseline_start": self.baseline_start, "baseline_end": self.baseline_end,
                "spark_start": self.spark_start}


def direction_of(trailing, baseline):
    """up / down / flat using the rise percent as the band; None when the trend is not computable."""
    if trailing is None or baseline is None:
        return None
    rise = TREND["rise_pct"] / 100.0
    if baseline == 0:
        return "up" if trailing > 0 else "flat"
    ratio = trailing / baseline
    if ratio >= 1 + rise:
        return "up"
    if ratio <= 1 - rise:
        return "down"
    return "flat"


def loss_state(level, threshold, trailing, baseline):
    """BROKEN / DETERIORATING / CHRONIC / CLEAN for a higher-is-worse metric. NO_DATA when level is None."""
    if level is None:
        return "NO_DATA", None
    direction = direction_of(trailing, baseline)
    if round(level, 2) >= threshold:
        return "BROKEN", direction
    min_level = threshold * TREND["min_share_of_threshold_pct"] / 100.0
    if direction == "up" and trailing is not None and trailing >= min_level:
        return "DETERIORATING", direction
    if direction == "flat" and trailing is not None and baseline is not None \
            and trailing >= min_level and baseline >= min_level:
        return "CHRONIC", direction
    return "CLEAN", direction


def floor_state(level, floor):
    if level is None:
        return "NO_DATA"
    return "BROKEN" if round(level, 1) < floor else "CLEAN"


# -------------------------------------------------------------------------------------
# Per-store computation
# -------------------------------------------------------------------------------------

def total_by_formula(c):
    """Your confirmed formula, kept literal:
    Total = BSD + BSE + BSNTE + Variance + Bad Returns + LIT + Damage + Short + Refund
            + RSTO Open Billed + RSTO Open DN Short + RSTO Total Dump - ESTO
    Variance = Manual Negative - Manual Positive; Damage = DN Other + NR; Short = Open DN Short."""
    variance = c["manual_negative"] - c["manual_positive"]
    damage = c["dn_other"] + c["nr"]
    short = c["open_dn_short"]
    return (c["bsd"] + c["bse"] + c["bsnte"] + variance + c["bad_returns"] + c["lit"] + damage + short
            + c["refund"] + c["rsto_open_billed"] + c["rsto_open_dn_short"] + c["rsto_total_dump"] - c["esto"])


def head_mapping_problems():
    """Every formula component must sit in exactly one head, with the formula sign."""
    formula_signs = {"bsd": 1, "bse": 1, "bsnte": 1, "manual_negative": 1, "manual_positive": -1,
                     "bad_returns": 1, "lit": 1, "dn_other": 1, "nr": 1, "open_dn_short": 1, "refund": 1,
                     "rsto_open_billed": 1, "rsto_open_dn_short": 1, "rsto_total_dump": 1, "esto": -1}
    seen, problems = {}, []
    for hk, h in HEADS.items():
        for col, sign, _status, in_total in h["components"]:
            if col in seen:
                problems.append(f"{col} is in both {seen[col]} and {hk}")
            seen[col] = hk
            if in_total and formula_signs.get(col) != sign:
                problems.append(f"{col} in {hk}: sign {sign} or membership differs from the total formula")
            if not in_total and col in formula_signs:
                problems.append(f"{col} is in the total formula but marked in_total False in {hk}")
    for col in formula_signs:
        if col not in seen:
            problems.append(f"{col} is in the total formula but in no head")
    return problems


class Ctx:
    def __init__(self, sources, master, win, generated_at):
        self.sources = sources
        self.master = master
        self.win = win
        self.generated_at = generated_at
        self.by_outlet = {}
        for k, s in sources.items():
            self.by_outlet[k] = {int(o): g for o, g in s.df.groupby("outlet_id")} if s.ok else {}

    def rows(self, key, oid):
        """(status, dataframe of real rows). status: ok | absent | missing | pending_access | error | not_configured."""
        src = self.sources[key]
        if not src.ok:
            return src.status, None
        g = self.by_outlet[key].get(oid)
        if g is None:
            return "absent", None
        spec = RESULT_SETS[key]
        if spec["kind"] == "list":
            g = g[g[spec["row_key"]].notna()]
        elif spec["kind"] == "daily":
            g = g[g["dt"].notna()]
            if g.empty:
                return "absent", None
        return "ok", g

    def snapshot(self, key):
        src = self.sources[key]
        if src.retrieved_at is None:
            return None
        return src.retrieved_at.astimezone(IST).replace(tzinfo=None)


def comp_sums(df):
    return {c: float(df[c].fillna(0).sum()) for c in LOSS_COLUMNS}


def head_rupees(c, hk, in_total_only=False):
    return sum(sign * c[col] for col, sign, _s, in_total in HEADS[hk]["components"] if in_total or not in_total_only)


def summary_payload(oid, ctx):
    win = ctx.win
    status, g = ctx.rows("loss_daily", oid)
    out = {"status": status}
    if status != "ok":
        return out
    g = g.sort_values("dt")
    mtd = g[(g["dt"] >= win.mtd_start) & (g["dt"] <= win.report_date)]
    c = comp_sums(mtd)
    orders = float(mtd["orders"].fillna(0).sum())
    out["orders_mtd"] = orders
    out["gmv_mtd"] = float(mtd["gmv"].fillna(0).sum())
    out["days_mtd"] = int(mtd["dt"].nunique())
    out["null_components"] = sorted([col for col in LOSS_COLUMNS if mtd[col].isna().any()])

    # Incidents: single events at or above the rupee size, inside the trend window.
    ev_status, ev = ctx.rows("loss_events", oid)
    if ctx.sources["loss_events"].ok and ev_status == "absent":
        ev_status, ev = "ok", ctx.sources["loss_events"].df.iloc[0:0]
    incidents, inc_by_day_head, inc_by_day_total = [], {}, {}
    if ev_status == "ok" and INCIDENT_MIN_RUPEES is not None:
        sel = ev[(ev["rupees"] >= INCIDENT_MIN_RUPEES) & (ev["dt"] >= win.baseline_start) & (ev["dt"] <= win.report_date)]
        for _, r in sel.sort_values("rupees", ascending=False).iterrows():
            head = text(r["head"])
            incidents.append({"dt": r["dt"], "head": head, "component": text(r["component"]),
                              "ref_id": text(r["ref_id"]), "item_name": text(r["item_name"]),
                              "rupees": num(r["rupees"])})
            key = (r["dt"], head)
            inc_by_day_head[key] = inc_by_day_head.get(key, 0.0) + float(r["rupees"])
            if head in HEADS and text(r["component"]) != "rts_short":
                inc_by_day_total[key] = inc_by_day_total.get(key, 0.0) + float(r["rupees"])
    out["incidents"] = incidents
    out["incidents_status"] = ev_status if INCIDENT_MIN_RUPEES is not None else "off"

    by_day = {r["dt"]: r for _, r in g.iterrows()}

    def window_po(hk, a, b, exclude_incidents=True):
        rs, od = 0.0, 0.0
        for d in win.days(a, b):
            r = by_day.get(d)
            if r is None or not (num(r["orders"]) or 0) > 0:
                return None
            cd = {col: float(r[col]) if not pd.isna(r[col]) else 0.0 for col in LOSS_COLUMNS}
            if hk == "total":
                v = total_by_formula(cd)
                inc = sum(val for (dd, h), val in inc_by_day_total.items() if dd == d)
            else:
                v = head_rupees(cd, hk)
                inc = inc_by_day_head.get((d, hk), 0.0)
            rs += v - (inc if exclude_incidents else 0.0)
            od += float(r["orders"])
        return rs / od if od else None

    def spark(hk):
        pts = []
        for d in win.days(win.spark_start, win.report_date):
            r = by_day.get(d)
            if r is None or not (num(r["orders"]) or 0) > 0:
                pts.append(None)
                continue
            cd = {col: float(r[col]) if not pd.isna(r[col]) else 0.0 for col in LOSS_COLUMNS}
            v = total_by_formula(cd) if hk == "total" else head_rupees(cd, hk)
            pts.append(v / float(r["orders"]))
        return pts

    central = None
    cst, cdf = ctx.rows("loss_central", oid)
    if cst == "ok" and len(cdf):
        central = cdf.iloc[0]
    out["central_status"] = cst

    def metric(hk, rupees, threshold, central_col):
        po = div(rupees, orders)
        cval = num(central[central_col]) if central is not None else None
        judged = po if cval is None or (po is not None and po >= cval) else cval
        trailing = window_po(hk, win.trailing_start, win.report_date)
        baseline = window_po(hk, win.baseline_start, win.baseline_end)
        st, direction = loss_state(judged, threshold, trailing, baseline)
        return {"rupees": rupees, "per_order": po, "central_per_order": cval, "judged": judged,
                "judged_source": None if cval is None else ("computed" if judged == po else "central"),
                "threshold": threshold, "trailing": trailing, "baseline": baseline,
                "state": st, "dir": direction, "spark": spark(hk)}

    total_rs = total_by_formula(c)
    out["total"] = metric("total", total_rs, THRESHOLDS["total"], "total_per_order")
    heads = {}
    heads_in_total = 0.0
    for hk, h in HEADS.items():
        rs = head_rupees(c, hk)
        heads_in_total += head_rupees(c, hk, in_total_only=True)
        m = metric(hk, rs, THRESHOLDS[hk], f"{hk}_per_order")
        m["label"] = h["label"]
        m["tab"] = h["tab"]
        m["components"] = [{"key": col, "label": COMPONENT_LABELS[col], "sign": sign, "status": st,
                            "in_total": in_total, "rupees": c[col] * sign, "per_order": div(c[col] * sign, orders)}
                           for col, sign, st, in_total in h["components"]]
        heads[hk] = m
    out["heads"] = heads
    out["identity"] = {"formula": total_rs, "heads_in_total": heads_in_total,
                       "ok": abs(total_rs - heads_in_total) < 0.01,
                       "rts_short_outside_total": c["rts_short"]}
    fwd = heads["forward"]
    out["forward_in_transit"] = {"rupees": c["fwd_in_transit"], "per_order": div(c["fwd_in_transit"], orders),
                                 "forward_minus_in_transit_rupees": fwd["rupees"] - c["fwd_in_transit"],
                                 "forward_minus_in_transit_per_order": div(fwd["rupees"] - c["fwd_in_transit"], orders),
                                 "exceeds_forward_gross": c["fwd_in_transit"] > (c["dn_other"] + c["nr"] + c["open_dn_short"]) + 0.01}
    out["crwi"] = {"rupees": c["crwi"], "per_order": div(c["crwi"], orders)}
    out["live_variance"] = {"rupees": c["manual_negative"] - c["manual_positive"],
                            "per_order": div(c["manual_negative"] - c["manual_positive"], orders)}
    out["fresh"] = {"fnv_rupees": c["fnv_loss"], "fnv_per_order": div(c["fnv_loss"], orders),
                    "milk_rupees": c["milk_loss"], "milk_per_order": div(c["milk_loss"], orders)}
    out["latest_dt"] = g["dt"].max()
    return out


def classify_variance(r):
    near = num(r.get("nearby_long_qty"))
    inward = num(r.get("inward_after_qty"))
    if near is not None and near > 0 and inward is not None and inward > 0:
        return "MATCHED_AND_INWARD", "Matched long nearby and offsetting inward"
    if near is not None and near > 0:
        return "MATCHED", "Matched short and long nearby (putaway or pick error)"
    if inward is not None and inward > 0:
        return "CORRECTION", "Offsetting inward after decrement (correction)"
    if near is not None and inward is not None and near == 0 and inward == 0:
        return "UNMATCHED", "Unmatched short (new loss)"
    return "UNCLASSIFIED", "unclassified"


def variance_payload(oid, ctx, orders_mtd):
    out = {}
    status, g = ctx.rows("variance_open", oid)
    out["open_status"] = status
    if status == "ok":
        snap = ctx.snapshot("variance_open")
        items = []
        for _, r in g.iterrows():
            r = r.to_dict()
            code, label = classify_variance(r)
            neg_loc = text(r["negative_location"]) or "location not in data"
            prob = text(r["probable_locations"])
            near_locs = text(r["nearby_long_locations"])
            if code in ("MATCHED", "MATCHED_AND_INWARD"):
                todo = f"Recount {neg_loc} and {near_locs or 'the matched location'}; move stock to its correct location"
            elif code == "CORRECTION":
                todo = f"Check the inward posted after the decrement; recount {neg_loc} and close if it offsets"
            elif code == "UNMATCHED":
                todo = f"Recount {neg_loc}" + (f" and {prob}" if prob else "") + "; if still short, raise RCA as new loss"
            else:
                todo = f"Recount {neg_loc}" + (f" and probable locations {prob}" if prob else "")
            first = r["first_negative_ts"]
            days_open = (snap - first).total_seconds() / 86400 if snap is not None and not pd.isna(first) else None
            items.append({"item_id": text(r["item_id"]), "item_name": text(r["item_name"]), "is_fnv": truthy(r["is_fnv"]),
                          "qty": num(r["open_qty"]), "rupees": num(r["open_value"]), "negative_location": neg_loc,
                          "probable_locations": prob, "last_auditor": text(r["last_auditor"]),
                          "last_audit_ts": iso(r["last_audit_ts"]), "days_open": days_open,
                          "disc_code": code, "discriminator": label, "nearby_long_locations": near_locs,
                          "todo": todo, "who": "SM to assign"})
        items.sort(key=lambda x: -(x["rupees"] or 0))
        open_rs = sum(i["rupees"] or 0 for i in items)
        fnv_rs = sum(i["rupees"] or 0 for i in items if i["is_fnv"])
        po = div(open_rs, orders_mtd)
        out.update({"items": items, "open_rupees": open_rs, "open_fnv_rupees": fnv_rs,
                    "open_non_fnv_rupees": open_rs - fnv_rs, "open_per_order": po,
                    "open_state": loss_state(po, THRESHOLDS["open_variance"], None, None)[0] if po is not None else "NO_DATA",
                    "disc_counts": {k: sum(1 for i in items if i["disc_code"] == k)
                                    for k in ("MATCHED", "MATCHED_AND_INWARD", "CORRECTION", "UNMATCHED", "UNCLASSIFIED")}})

    status, g = ctx.rows("audit_pending", oid)
    out["audit_status"] = status
    if status == "ok":
        snap = ctx.snapshot("audit_pending")
        rows = []
        for _, r in g.iterrows():
            created = r["created_ts"]
            due = r["due_ts"]
            age_h = (snap - created).total_seconds() / 3600 if snap is not None and not pd.isna(created) else None
            overdue = bool(snap is not None and not pd.isna(due) and due < snap)
            atype = (text(r["audit_type"]) or "").upper()
            loc = text(r["location"]) or "-"
            rows.append({"task_id": text(r["task_id"]), "audit_type": atype, "item_id": text(r["item_id"]),
                         "item_name": text(r["item_name"]), "location": loc, "who": text(r["assigned_to"]) or "unassigned",
                         "created_ts": iso(created), "due_ts": iso(due), "age_hours": age_h, "overdue": overdue,
                         "todo": f"Complete {atype.lower() or 'pending'} audit at {loc}"})
        rows.sort(key=lambda x: (not x["overdue"], -(x["age_hours"] or 0)))
        out["audits"] = rows

    status, g = ctx.rows("auditor_quality", oid)
    out["auditor_status"] = status
    if status == "ok":
        line = MIN_AUDIT_SEC_PER_UNIT
        line_source = "CONFIG MIN_AUDIT_SEC_PER_UNIT"
        if line is None and "min_audit_sec_per_unit" in g.columns and g["min_audit_sec_per_unit"].notna().any():
            line = float(g["min_audit_sec_per_unit"].dropna().max())
            line_source = "auditor_quality.min_audit_sec_per_unit"
        points, auditors = [], []
        for _, r in g.iterrows():
            spu = div(r["audit_seconds"], r["units_touched"])
            points.append({"dt": r["dt"], "auditor": text(r["auditor"]), "units": num(r["units_touched"]),
                           "sec_per_unit": spu, "below_line": bool(line is not None and spu is not None and spu < line)})
        for name, a in g.groupby("auditor"):
            units, secs = float(a["units_touched"].sum()), float(a["audit_seconds"].sum())
            inputs, correct = float(a["inputs_total"].sum()), float(a["inputs_correct"].sum())
            spu = div(secs, units)
            acc = div(correct * 100, inputs)
            auditors.append({"auditor": text(name), "days": int(a["dt"].nunique()), "units": units, "seconds": secs,
                             "sec_per_unit": spu, "inputs": inputs, "correct": correct, "accuracy_pct": acc,
                             "below_line_days": sum(1 for p in points if p["auditor"] == text(name) and p["below_line"]),
                             "accuracy_below_target": acc is not None and acc < THRESHOLDS["auditor_accuracy_pct"]})
        auditors.sort(key=lambda x: (-(x["below_line_days"]), x["accuracy_pct"] if x["accuracy_pct"] is not None else 999))
        dts = sorted(set(g["dt"].dropna()))
        out.update({"auditor_points": points, "auditors": auditors, "min_line": line,
                    "min_line_source": line_source if line is not None else None,
                    "auditor_window": [dts[0], dts[-1]] if dts else None})
    return out


def wastage_payload(oid, ctx):
    win = ctx.win
    out = {}
    status, g = ctx.rows("wastage_daily", oid)
    out["daily_status"] = status
    if status == "ok":
        mtd = g[(g["dt"] >= win.mtd_start) & (g["dt"] <= win.report_date)]
        s = {c: float(mtd[c].fillna(0).sum()) for c in RESULT_SETS["wastage_daily"]["numeric"]}
        non_fresh_dump = s["dump_total"] - s["dump_fnv"] - s["dump_milk"]
        non_fresh_sales = s["sales_total"] - s["sales_fnv"] - s["sales_milk"]
        created = s["nte_tasks_created"] + s["expiry_tasks_created"]
        closed = s["nte_tasks_closed"] + s["expiry_tasks_closed"]
        closure = div(closed * 100, created)
        marking = div(s["dump_lines_marked"] * 100, s["dump_lines_eligible"])
        neg = []
        for _, r in g.iterrows():
            for col in ("dump_total", "dump_fnv", "dump_milk"):
                if num(r[col]) is not None and r[col] < 0:
                    neg.append({"dt": r["dt"], "column": col, "value": float(r[col])})
            if num(r["negative_wastage_lines"]) and r["negative_wastage_lines"] > 0:
                neg.append({"dt": r["dt"], "column": "negative_wastage_lines", "value": float(r["negative_wastage_lines"])})
        ls, lg = ctx.rows("loss_daily", oid)
        if ls == "ok":
            for _, r in lg.iterrows():
                for col in ("bsd", "bse", "bsnte", "fnv_loss", "milk_loss"):
                    if num(r[col]) is not None and r[col] < 0:
                        neg.append({"dt": r["dt"], "column": f"loss_daily.{col}", "value": float(r[col])})

        def series(numer, denom):
            pts = []
            by_day = {r["dt"]: r for _, r in g.iterrows()}
            for d in win.days(win.spark_start, win.report_date):
                r = by_day.get(d)
                if r is None:
                    pts.append(None)
                    continue
                n = sum(float(r[x]) for x in numer if not pd.isna(r[x]))
                dd = sum(float(r[x]) for x in denom if not pd.isna(r[x]))
                pts.append(n * 100 / dd if dd else None)
            return pts

        out.update({
            "sales": {"total": s["sales_total"], "fnv": s["sales_fnv"], "milk": s["sales_milk"], "non_fresh": non_fresh_sales},
            "dump": {"total": s["dump_total"], "fnv": s["dump_fnv"], "milk": s["dump_milk"], "non_fresh": non_fresh_dump},
            "dump_pct": {"total": div(s["dump_total"] * 100, s["sales_total"]), "fnv": div(s["dump_fnv"] * 100, s["sales_fnv"]),
                         "milk": div(s["dump_milk"] * 100, s["sales_milk"]), "non_fresh": div(non_fresh_dump * 100, non_fresh_sales)},
            "closure": {"pct": closure, "closed": closed, "created": created, "state": floor_state(closure, THRESHOLDS["nte_expiry_closure_pct"]),
                        "nte_pct": div(s["nte_tasks_closed"] * 100, s["nte_tasks_created"]),
                        "nte_closed": s["nte_tasks_closed"], "nte_created": s["nte_tasks_created"],
                        "expiry_pct": div(s["expiry_tasks_closed"] * 100, s["expiry_tasks_created"]),
                        "expiry_closed": s["expiry_tasks_closed"], "expiry_created": s["expiry_tasks_created"],
                        "spark": series(["nte_tasks_closed", "expiry_tasks_closed"], ["nte_tasks_created", "expiry_tasks_created"])},
            "marking": {"pct": marking, "marked": s["dump_lines_marked"], "eligible": s["dump_lines_eligible"],
                        "state": floor_state(marking, THRESHOLDS["dump_marking_pct"]),
                        "spark": series(["dump_lines_marked"], ["dump_lines_eligible"])},
            "negative_wastage": neg,
        })

    status, g = ctx.rows("wastage_open_tasks", oid)
    out["tasks_status"] = status
    if status == "ok":
        snap = ctx.snapshot("wastage_open_tasks")
        rows = []
        for _, r in g.iterrows():
            ttype = (text(r["task_type"]) or "").upper()
            loc = text(r["location"]) or "-"
            age_h = (snap - r["created_ts"]).total_seconds() / 3600 if snap is not None and not pd.isna(r["created_ts"]) else None
            qty = num(r["qty"])
            rows.append({"task_id": text(r["task_id"]), "task_type": ttype, "item_id": text(r["item_id"]),
                         "item_name": text(r["item_name"]), "is_fnv": truthy(r["is_fnv"]), "is_milk": truthy(r["is_milk"]),
                         "location": loc, "qty": qty, "rupees": num(r["value"]), "created_ts": iso(r["created_ts"]),
                         "age_hours": age_h, "who": text(r["assigned_to"]) or "SM to assign",
                         "todo": f"Close {ttype or 'open'} task at {loc}" + (f" ({qty:g} units)" if qty is not None else "")})
        rows.sort(key=lambda x: -(x["age_hours"] or 0))
        out["tasks"] = rows

    status, g = ctx.rows("near_expiry", oid)
    out["near_status"] = status
    if status == "ok":
        rows = []
        for _, r in g.iterrows():
            exp = r["expiry_date"]
            days = (exp - win.report_date).days - 1 if exp is not None and not pd.isna(exp) else None
            loc = text(r["location"]) or "-"
            rows.append({"item_id": text(r["item_id"]), "item_name": text(r["item_name"]), "is_fnv": truthy(r["is_fnv"]),
                         "is_milk": truthy(r["is_milk"]), "location": loc, "qty": num(r["qty"]), "rupees": num(r["value"]),
                         "expiry_date": exp, "days_to_expiry": days, "who": "SM to assign",
                         "todo": f"Action near-expiry stock at {loc}" + (f": {days} day(s) to expiry" if days is not None else "")})
        rows.sort(key=lambda x: (x["days_to_expiry"] if x["days_to_expiry"] is not None else 999, -(x["rupees"] or 0)))
        out["near"] = rows
    return out


COMPLAINT_TYPES = [
    ("mdnd", "MDND", "P1"), ("item_missing", "Item missing", "P2"), ("item_damaged", "Item damaged", None),
    ("item_expired", "Item expired", "P0"), ("wrong_item", "Wrong item", None), ("qng", "QNG", None),
]
COMPLAINT_PRIORITY = {"MDND": "P1", "ITEM_MISSING": "P2", "ITEM MISSING": "P2", "ITEM_EXPIRED": "P0", "ITEM EXPIRED": "P0"}


def complaints_payload(oid, ctx):
    win = ctx.win
    out = {}
    status, g = ctx.rows("complaints_daily", oid)
    out["daily_status"] = status
    if status == "ok":
        by_day = {r["dt"]: r for _, r in g.iterrows()}

        def pct_window(a, b):
            c = o = 0.0
            for d in win.days(a, b):
                r = by_day.get(d)
                if r is None or not (num(r["orders"]) or 0) > 0:
                    return None
                c += float(r["complaints"])
                o += float(r["orders"])
            return c * 100 / o if o else None

        d1 = by_day.get(win.report_date)
        d1_pct = div(float(d1["complaints"]) * 100, d1["orders"]) if d1 is not None else None
        mtd = g[(g["dt"] >= win.mtd_start) & (g["dt"] <= win.report_date)]
        s = {c: float(mtd[c].fillna(0).sum()) for c in RESULT_SETS["complaints_daily"]["numeric"]}
        trailing = pct_window(win.trailing_start, win.report_date)
        baseline = pct_window(win.baseline_start, win.baseline_end)
        st, direction = loss_state(d1_pct, THRESHOLDS["complaint_pct"], trailing, baseline)
        spark = []
        for d in win.days(win.spark_start, win.report_date):
            r = by_day.get(d)
            spark.append(div(float(r["complaints"]) * 100, r["orders"]) if r is not None else None)
        out.update({
            "d1": {"pct": d1_pct, "complaints": num(d1["complaints"]) if d1 is not None else None,
                   "orders": num(d1["orders"]) if d1 is not None else None},
            "mtd": {"pct": div(s["complaints"] * 100, s["orders"]), "complaints": s["complaints"], "orders": s["orders"]},
            "state": st, "dir": direction, "trailing": trailing, "baseline": baseline, "spark": spark,
            "types": [{"key": k, "label": lbl, "priority": p, "count": s[k], "pct": div(s[k] * 100, s["orders"])}
                      for k, lbl, p in COMPLAINT_TYPES],
            "qng_fnv": {"count": s["qng_fnv"], "share_of_qng_pct": div(s["qng_fnv"] * 100, s["qng"]),
                        "pct_of_orders": div(s["qng_fnv"] * 100, s["orders"])},
        })

    status, g = ctx.rows("complaints_open", oid)
    out["open_status"] = status
    if status == "ok":
        snap = ctx.snapshot("complaints_open")
        rows = []
        for _, r in g.iterrows():
            age_h = (snap - r["created_ts"]).total_seconds() / 3600 if snap is not None and not pd.isna(r["created_ts"]) else None
            ctype = text(r["complaint_type"]) or "-"
            cid = text(r["external_complaint_id"])
            rows.append({"complaint_id": cid, "order_id": text(r["order_id"]), "complaint_type": ctype,
                         "priority": COMPLAINT_PRIORITY.get(ctype.upper()), "item_id": text(r["item_id"]),
                         "item_name": text(r["item_name"]), "is_fnv": truthy(r["is_fnv"]), "picker": text(r["picker"]),
                         "created_ts": iso(r["created_ts"]), "age_hours": age_h,
                         "past_rci": bool(age_h is not None and age_h > THRESHOLDS["rci_hours"]),
                         "who": "SM to assign",
                         "todo": f"Close RCI for complaint {cid} (order {text(r['order_id']) or '-'})"})
        rows.sort(key=lambda x: -(x["age_hours"] or 0))
        out["open"] = rows
    return out


def forward_payload(oid, ctx, summary):
    out = {}
    status, g = ctx.rows("forward_open", oid)
    out["open_status"] = status
    past6 = None
    if status == "ok":
        snap = ctx.snapshot("forward_open")
        rows, buckets = [], {"under 2h": 0, "2h to 4h": 0, "4h to 6h": 0, "over 6h": 0}
        for _, r in g.iterrows():
            age_m = (snap - r["arrived_ts"]).total_seconds() / 60 if snap is not None and not pd.isna(r["arrived_ts"]) else None
            over = bool(age_m is not None and age_m > THRESHOLDS["consignment_open_hours"] * 60)
            if age_m is not None:
                b = "under 2h" if age_m < 120 else "2h to 4h" if age_m < 240 else "4h to 6h" if age_m <= 360 else "over 6h"
                buckets[b] += 1
            st = (text(r["status"]) or "").upper()
            cid = text(r["consignment_id"])
            if "UNLOAD" in st or st in ("ARRIVED", "REACHED"):
                todo = f"Unload consignment {cid}"
            elif "GRN" in st:
                todo = f"Complete GRN for consignment {cid}"
            elif "PUTAWAY" in st:
                todo = f"Complete putaway for consignment {cid}"
            elif "TRANSIT" in st or "DISPATCH" in st:
                todo = f"Track arrival of consignment {cid}"
            else:
                todo = f"Close consignment {cid} ({st or 'status not in data'})"
            rows.append({"consignment_id": cid, "source_name": text(r["source_name"]), "status": st,
                         "priority": (text(r["priority"]) or "").upper() or None, "arrived_ts": iso(r["arrived_ts"]),
                         "age_minutes": age_m, "past_6h": over, "units_expected": num(r["units_expected"]),
                         "units_unloaded": num(r["units_unloaded"]), "units_putaway": num(r["units_putaway"]),
                         "grn_pending_units": num(r["grn_pending_units"]), "rupees": num(r["value"]),
                         "who": "SM to assign", "todo": todo})
        prio_rank = {"P0": 0, "P1": 1, "P2": 2}
        rows.sort(key=lambda x: (prio_rank.get(x["priority"], 9), -(x["age_minutes"] or 0)))
        exp = sum(r["units_expected"] or 0 for r in rows)
        unl = sum(r["units_unloaded"] or 0 for r in rows)
        put = sum(r["units_putaway"] or 0 for r in rows)
        past6 = sum(1 for r in rows if r["past_6h"])
        out.update({"open": rows, "age_buckets": buckets, "units_expected": exp, "units_unloaded": unl,
                    "units_putaway": put, "unload_pct": div(unl * 100, exp), "putaway_pct": div(put * 100, exp),
                    "grn_putaway_pending_units": sum(r["grn_pending_units"] or 0 for r in rows),
                    "past_6h_count": past6})

    status, g = ctx.rows("forward_dn", oid)
    out["dn_status"] = status
    if status == "ok":
        win = ctx.win
        g = g[(g["dt"] >= win.mtd_start) & (g["dt"] <= win.report_date)]
        rows = []
        for _, r in g.iterrows():
            t = (text(r["dn_type"]) or "").upper()
            cid = text(r["consignment_id"])
            rows.append({"dt": r["dt"], "consignment_id": cid, "dn_type": t, "item_id": text(r["item_id"]),
                         "item_name": text(r["item_name"]), "is_fnv": truthy(r["is_fnv"]), "qty": num(r["qty"]),
                         "rupees": num(r["value"]), "who": "SM to assign",
                         "todo": f"Verify DN {t.lower() or 'line'} on consignment {cid}"})
        rows.sort(key=lambda x: -(x["rupees"] or 0))
        tot = lambda t, fnv=None: sum(x["rupees"] or 0 for x in rows if x["dn_type"] == t and (fnv is None or x["is_fnv"] == fnv))  # noqa: E731
        out.update({"dn": rows, "dn_short_rupees": tot("SHORT"), "dn_damage_rupees": tot("DAMAGE"),
                    "dn_short_fnv_rupees": tot("SHORT", True), "dn_damage_fnv_rupees": tot("DAMAGE", True)})

    status, g = ctx.rows("forward_crates", oid)
    out["crates_status"] = status
    if status == "ok" and len(g):
        r = g.iloc[0]
        adherence = div(float(r["scans_done"]) * 100, r["scans_expected"])
        pre1 = adherence is not None and adherence >= CRATE_SCAN_ADHERENCE_MIN_PCT
        pre2 = past6 == 0 if past6 is not None else None
        usable = bool(pre1 and pre2)
        out["crates"] = {
            "scan_adherence_pct": adherence, "scans_done": num(r["scans_done"]), "scans_expected": num(r["scans_expected"]),
            "pre_scan_ok": pre1, "pre_no_consignment_past_6h": pre2, "usable": usable,
            "crate_attrib_pct": div(float(r["crate_attrib_open_dn_value"]) * 100, r["open_dn_value"]) if usable else None,
            "crate_attrib_rupees": num(r["crate_attrib_open_dn_value"]) if usable else None,
            "open_dn_rupees": num(r["open_dn_value"]),
            "age_buckets": {"0 to 24h": num(r["crates_0_24h"]), "24h to 48h": num(r["crates_24_48h"]),
                            "48h to 72h": num(r["crates_48_72h"]), "over 72h": num(r["crates_72h_plus"])},
        }
    return out


def reverse_payload(oid, ctx):
    out = {}
    status, g = ctx.rows("reverse_open", oid)
    out["open_status"] = status
    if status == "ok":
        snap = ctx.snapshot("reverse_open")
        rows = []
        for _, r in g.iterrows():
            age_d = (snap - r["created_ts"]).total_seconds() / 86400 if snap is not None and not pd.isna(r["created_ts"]) else None
            dtype = (text(r["doc_type"]) or "").upper()
            state = (text(r["state"]) or "").upper()
            doc = text(r["doc_id"])
            dest = text(r["destination"]) or "destination"
            if "BILLED" in state:
                todo = f"Dispatch {dtype} {doc} (billed, not dispatched)"
            elif "DISPATCH" in state:
                todo = f"Follow up receipt of {dtype} {doc} at {dest}"
            elif "SHORT" in state:
                todo = f"Reconcile DN short on {dtype} {doc} with {dest}"
            else:
                todo = f"Close {dtype} {doc} ({state or 'state not in data'})"
            rows.append({"doc_type": dtype, "doc_id": doc, "state": state, "destination": text(r["destination"]),
                         "qty": num(r["qty"]), "rupees": num(r["value"]), "fnv_rupees": num(r["fnv_value"]),
                         "created_ts": iso(r["created_ts"]), "age_days": age_d, "who": "SM to assign", "todo": todo})
        rows.sort(key=lambda x: -(x["age_days"] or 0))
        totals = {}
        for x in rows:
            k = f"{x['doc_type']} {x['state']}"
            t = totals.setdefault(k, {"label": k, "docs": 0, "rupees": 0.0, "fnv_rupees": 0.0})
            t["docs"] += 1
            t["rupees"] += x["rupees"] or 0
            t["fnv_rupees"] += x["fnv_rupees"] or 0
        out.update({"open": rows, "totals": sorted(totals.values(), key=lambda t: t["label"])})
    return out


STATE_RANK = {"NO_DATA": 0, "BROKEN": 1, "DETERIORATING": 2, "CHRONIC": 3, "CLEAN": 4}


def exceptions_for(store):
    """Exceptions for the CM list. Sorted by state, then by level as a share of its threshold.
    Never by absolute rupees."""
    ex = []
    s = store["summary"]
    if s.get("status") != "ok":
        ex.append({"metric": "Loss heads", "state": "NO_DATA", "dir": None, "tab": "summary",
                   "text": f"loss_daily: {s.get('status')}", "ratio": 99})
    else:
        for hk, m in [("total", s["total"])] + list(s["heads"].items()):
            if m["state"] in ("BROKEN", "DETERIORATING", "CHRONIC", "NO_DATA"):
                label = "Total" if hk == "total" else m["label"]
                ex.append({"metric": label, "state": m["state"], "dir": m["dir"],
                           "tab": "summary" if hk == "total" else m["tab"],
                           "text": f"{label} {m['judged']:.2f} vs {m['threshold']:.2f} per {DENOMINATOR['short']}" if m["judged"] is not None else f"{label} no data",
                           "ratio": (m["judged"] or 0) / m["threshold"]})
    v = store["variance"]
    if v.get("open_status") in ("ok",) and v.get("open_per_order") is not None and v["open_state"] == "BROKEN":
        ex.append({"metric": "Open variance", "state": "BROKEN", "dir": None, "tab": "variance",
                   "text": f"Open variance {v['open_per_order']:.2f} vs 0.70 per {DENOMINATOR['short']}",
                   "ratio": v["open_per_order"] / THRESHOLDS["open_variance"]})
    c = store["complaints"]
    if c.get("daily_status") == "ok" and c["state"] in ("BROKEN", "DETERIORATING", "CHRONIC", "NO_DATA"):
        ex.append({"metric": "Complaints", "state": c["state"], "dir": c["dir"], "tab": "complaints",
                   "text": (f"Complaints D-1 {c['d1']['pct']:.2f}% vs 1.5%" if c["d1"]["pct"] is not None else "Complaints D-1 no data"),
                   "ratio": (c["d1"]["pct"] or 0) / THRESHOLDS["complaint_pct"]})
    w = store["wastage"]
    if w.get("daily_status") == "ok":
        if w["closure"]["state"] == "BROKEN":
            ex.append({"metric": "NTE/expiry closure", "state": "BROKEN", "dir": None, "tab": "wastage",
                       "text": f"Task closure {w['closure']['pct']:.1f}% vs 95% floor", "ratio": 1.0})
        if w["marking"]["state"] == "BROKEN":
            ex.append({"metric": "Dump marking", "state": "BROKEN", "dir": None, "tab": "wastage",
                       "text": f"Dump marking {w['marking']['pct']:.1f}% vs 60% floor", "ratio": 1.0})
    f = store["forward"]
    if f.get("past_6h_count"):
        ex.append({"metric": "Consignments past 6h", "state": "BROKEN", "dir": None, "tab": "forward",
                   "text": f"{f['past_6h_count']} consignment(s) open past 6h", "ratio": 1.0})
    for key, status in store["coverage"].items():
        if status == "absent" and not RESULT_SETS[key].get("optional_source"):
            ex.append({"metric": key, "state": "NO_DATA", "dir": None,
                       "tab": RESULT_SETS[key]["charter"] if RESULT_SETS[key]["charter"] != "summary" else "variance",
                       "text": f"Absent from {key}: data missing, not clean", "ratio": 99})
    ex.sort(key=lambda e: (STATE_RANK.get(e["state"], 9), -e["ratio"]))
    return ex


def sort_key(store):
    ex = store["exceptions"]
    counts = [sum(1 for e in ex if e["state"] == s) for s in ("NO_DATA", "BROKEN", "DETERIORATING", "CHRONIC")]
    top_ratio = max([e["ratio"] for e in ex], default=0)
    return [-counts[0], -counts[1], -counts[2], -counts[3], -top_ratio]


def build_store(oid, ctx):
    win = ctx.win
    m = ctx.master["stores"].get(oid)
    if m is None:
        name, cm, cm_status = None, None, "master_missing"
        go_live = typ = mode = None
    else:
        name = m.get("store_name")
        cm_raw = m.get("cm")
        if cm_raw is None or cm_raw.strip().lower() in UNASSIGNED_CM_VALUES:
            cm, cm_status = None, "unassigned"
        else:
            cm, cm_status = cm_raw.strip(), "assigned"
        go_live, typ, mode = m.get("go_live"), m.get("type"), m.get("mode")
    age = (win.report_date - go_live).days if go_live else None
    store = {"id": oid, "name": name, "cm": cm, "cm_status": cm_status, "cluster": CLUSTER_OF[oid],
             "go_live": go_live, "age_days": age, "is_new": bool(age is not None and age < NEW_STORE_DAYS),
             "type": typ, "mode": mode}
    store["summary"] = summary_payload(oid, ctx)
    orders = store["summary"].get("orders_mtd")
    store["variance"] = variance_payload(oid, ctx, orders)
    store["wastage"] = wastage_payload(oid, ctx)
    store["complaints"] = complaints_payload(oid, ctx)
    store["forward"] = forward_payload(oid, ctx, store["summary"])
    store["reverse"] = reverse_payload(oid, ctx)
    store["coverage"] = {k: (ctx.rows(k, oid)[0]) for k in RESULT_SETS}
    store["exceptions"] = exceptions_for(store)
    store["sort_key"] = sort_key(store)
    return store


# -------------------------------------------------------------------------------------
# Data control checks
# -------------------------------------------------------------------------------------

def run_checks(sources, stores, master, ctx, generated_at):
    checks = []

    def add(name, ok, detail, info=None):
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "info": info or []})

    # 1. Every allowlist outlet present in each result set.
    detail, info = [], []
    for k, s in sources.items():
        if s.ok:
            df = s.df[s.df["dt"].notna()] if RESULT_SETS[k]["kind"] == "daily" else s.df
            present = set(df["outlet_id"].unique())
            missing = [o for o in ALLOWLIST if o not in present]
            if missing:
                detail.append(f"{k}: {len(missing)} outlet(s) absent: {', '.join(map(str, missing))}")
            if s.dropped_out_of_scope:
                info.append(f"{k}: {len(s.dropped_out_of_scope)} out-of-scope outlet(s) dropped")
        elif not RESULT_SETS[k].get("optional_source"):
            detail.append(f"{k}: no data ({s.status})")
    add("Every allowlist outlet present in each result set", not detail, detail, info)

    # 2. Store count.
    detail = []
    if len(set(ALLOWLIST)) != EXPECTED_STORE_COUNT or len(ALLOWLIST) != EXPECTED_STORE_COUNT:
        detail.append(f"allowlist has {len(set(ALLOWLIST))} unique of {len(ALLOWLIST)} listed, expected {EXPECTED_STORE_COUNT}")
    for c, n in EXPECTED_CLUSTER_COUNTS.items():
        if len(CLUSTERS.get(c, [])) != n:
            detail.append(f"{c}: {len(CLUSTERS.get(c, []))} outlets, expected {n}")
    if len(stores) != EXPECTED_STORE_COUNT:
        detail.append(f"output has {len(stores)} stores, expected {EXPECTED_STORE_COUNT}")
    add(f"Store count in output equals {EXPECTED_STORE_COUNT}", not detail, detail)

    # 3. Freshness.
    detail = []
    for k, s in sources.items():
        if not s.ok:
            if not RESULT_SETS[k].get("optional_source") or s.status not in ("missing", "not_configured"):
                detail.append(f"{k}: {s.status}" + (f" ({s.error})" if s.error else ""))
            continue
        limit = QUERIES.get(k, {}).get("stale_hours") or STALENESS_LIMIT_HOURS
        age_h = (generated_at - s.retrieved_at).total_seconds() / 3600 if s.retrieved_at else None
        if age_h is None:
            detail.append(f"{k}: retrieved_at unknown")
        elif age_h > limit:
            detail.append(f"{k}: STALE, retrieved {s.retrieved_at:%Y-%m-%d %H:%M} IST, {age_h:.1f}h old, limit {limit:g}h")
    add("Freshness of each query", not detail, detail)

    # 4. Negative wastage (data integrity, not ops).
    detail = []
    for oid, st in stores.items():
        for n in st["wastage"].get("negative_wastage", []) or []:
            detail.append(f"{oid} {n['dt']}: {n['column']} = {n['value']:g}")
    add("No negative wastage (data integrity)", not detail, detail)

    # 5. Orders > 0 with GMV zero.
    detail = []
    s = sources["loss_daily"]
    if s.ok:
        bad = s.df[(s.df["orders"].fillna(0) > 0) & (s.df["gmv"].fillna(0) == 0)]
        detail = [f"{int(r.outlet_id)} {r.dt}: orders {r.orders:g}, GMV 0" for r in bad.itertuples()]
    else:
        detail = ["loss_daily not available"]
    add("No day with orders > 0 and GMV zero", not detail, detail)

    # 6. Duplicate rows on each result set's grain.
    detail = []
    for k, src in sources.items():
        if src.ok:
            spec = RESULT_SETS[k]
            df = src.df
            if spec["kind"] == "list":
                df = df[df[spec["row_key"]].notna()]
            dup = df[df.duplicated(subset=spec["key"], keep=False)]
            if len(dup):
                outs = sorted(set(dup["outlet_id"]))
                detail.append(f"{k}: {len(dup)} rows duplicate on ({', '.join(spec['key'])}); outlets {', '.join(map(str, outs[:10]))}")
    add("No duplicate store rows", not detail, detail)

    # 7. Arithmetic identity: total formula equals the sum of heads (components in the total).
    detail = []
    for oid, st in stores.items():
        idt = st["summary"].get("identity")
        if idt and not idt["ok"]:
            detail.append(f"{oid}: formula {idt['formula']:.2f} vs heads {idt['heads_in_total']:.2f}")
    detail = head_mapping_problems() + detail
    add("Total per order equals sum of heads; every component in one head", not detail, detail)

    # 8. Last day present (window anchored on D-1 IST, no partial day).
    detail = []
    if s.ok:
        for oid, st in stores.items():
            ld = st["summary"].get("latest_dt")
            if ld is not None and ld < ctx.win.report_date:
                detail.append(f"{oid}: latest loss day {ld}, report date {ctx.win.report_date}")
            if ld is not None and ld > ctx.win.report_date:
                detail.append(f"{oid}: data for {ld} is after the report date (partial day?)")
    add("Loss data reaches D-1 and no later", not detail, detail)

    # 9. Store master.
    detail = list(master["notes"])
    missing = [o for o in ALLOWLIST if o not in master["stores"]]
    if master["path"] and missing:
        detail.append(f"{len(missing)} allowlist outlet(s) not in store master: {', '.join(map(str, missing))}")
    add("Store master covers all 48 outlets", not detail, detail)

    # 10. Values that did not parse.
    detail = []
    for k, src in sources.items():
        for col, n in src.unparsed.items():
            detail.append(f"{k}.{col}: {n} value(s) not parsed")
    add("All values parsed", not detail, detail)

    # 11. Second source identity and in-transit inside forward.
    detail = []
    cs = sources["loss_central"]
    if cs.ok:
        for r in cs.df.itertuples():
            heads = sum(getattr(r, f"{h}_per_order") or 0 for h in HEADS)
            if r.total_per_order is not None and abs(r.total_per_order - heads) > 0.05:
                detail.append(f"loss_central {r.outlet_id}: total {r.total_per_order:.2f} vs heads {heads:.2f}")
    for oid, st in stores.items():
        ft = st["summary"].get("forward_in_transit")
        if ft and ft["exceeds_forward_gross"]:
            detail.append(f"{oid}: forward in transit exceeds forward gross (DN other + NR + open DN short)")
    add("Second-source identity and in-transit within forward", not detail, detail)
    return checks


# -------------------------------------------------------------------------------------
# Definitions panel
# -------------------------------------------------------------------------------------

def definitions(win):
    d = DENOMINATOR
    den = f"{d['short']} ({d['column']})"
    mtd = f"MTD {win.mtd_start:%d %b} to {win.report_date:%d %b %Y}, IST, D-1"
    trend = (f"trend: trailing {TREND['trailing_days']}d vs baseline {TREND['baseline_days']}d, "
             "heuristic, uncalibrated")
    rows = [
        ["Total loss per order", "BSD + BSE + BSNTE + Variance + Bad Returns + LIT + Damage + Short + Refund + RSTO Open Billed + RSTO Open DN Short + RSTO Total Dump - ESTO",
         den, d["source"], "confirmed formula", "8.0", f"{mtd}; {trend}", "store x day, summed to MTD",
         "FNV and Milk kept out (shown as their own column). 'Total Wastage' in head-level sheets is this figure. Where the central sheet is loaded, the higher of the two is shown, the lower beside it."],
        ["In-store loss per order", "BSD + BSE + BSNTE + (Manual Negative - Manual Positive)", den, d["source"],
         "confirmed", "3.5", mtd, "store x day", "Variance here is live MTD variance. It is not open variance and is never compared with it."],
        ["Forward loss per order", "DN Other + NR + Open DN Short - ESTO", den, d["source"], "confirmed (ESTO nets as credit)",
         "1.5", mtd, "store x day", "In-transit (open billed + open dispatch) stays in forward; 'forward minus in transit' shown beside it. In-transit is assumed to be inside Open DN Short (UNVALIDATED)."],
        ["Reverse loss per order", "RSTO Open Billed + RSTO Open DN Short + RSTO Total Dump + RTS Short (gross)", den, d["source"],
         "inferred: RSTO open billed, RSTO open DN short, RSTO total dump, RTS short", "1.5", mtd, "store x day",
         "RTS Short is in the reverse head but not in the total formula, so heads sum to total + RTS Short. CRWI shown as a separate line, not netted."],
        ["Returns and refunds per order", "Refund + Bad Returns + LIT", den, d["source"], "confirmed", "1.5", mtd, "store x day", ""],
        ["Open variance per order", "Sum of open variance value (open items now)", f"MTD {den}", d["source"],
         "variance book (separate from RSTO)", "0.70", "open at data pull; denominator MTD", "store x item x location",
         "Open variance and live (MTD) variance are different series; never mixed or compared. Denominator window UNCONFIRMED."],
        ["Variance discriminator", "Nearby long qty > 0: matched (putaway or pick error); inward after decrement > 0: correction; both computed and 0: unmatched short (new loss)",
         "-", "variance_open evidence columns", "-", "-", "open at data pull", "store x item x location",
         "Shown only where both evidence columns support it; otherwise 'unclassified'."],
        ["Audit time per unit", "Sum audit seconds", "Sum units touched", "auditor_quality", "-",
         "minimum-audit-time line (CONFIG; not set means not drawn)", "query window (shown on panel)", "auditor x day",
         "Recomputed from components, never an average of daily averages."],
        ["Auditor input accuracy", "Sum correct inputs", "Sum inputs", "auditor_quality", "-", "100%", "query window", "auditor x day", "Recomputed from components."],
        ["NTE and expiry task closure", "Tasks closed", "Tasks created (by creation date)", "wastage_daily", "-", "95% floor", mtd, "store x day",
         "Closure counts tasks created in the window that are closed."],
        ["Dump marking compliance", "Dump lines marked", "Dump lines eligible", "wastage_daily", "-", "60% floor", mtd, "store x day",
         "Definition of 'eligible' UNCONFIRMED."],
        ["Dump percent of sales", "Dump value", "Sales value (same category)", "wastage_daily", "-", "none given", mtd, "store x day",
         "Shown separately for non-fresh, FNV and Milk."],
        ["Negative wastage", "Any dump or BSD/BSE/BSNTE/FNV/Milk value below zero, or negative wastage lines", "-", "wastage_daily, loss_daily",
         "-", "zero occurrences", "rows loaded", "store x day", "Data integrity issue, not an ops issue."],
        ["Complaint percent", "COUNT(DISTINCT external_complaint_id)", den + " (same day)", "storeops.order_complaint_v2 (UNVALIDATED join)", "-",
         "1.5%", f"D-1 ({win.report_date:%d %b}); MTD beside; {trend}", "store x day", "Never a plain COUNT: product-line grain inflates MDND."],
        ["Complaint types", "COUNT(DISTINCT external_complaint_id) per type", den, "storeops.order_complaint_v2", "-",
         "MDND P1, item missing P2, item expired P0", mtd, "store x day", "FNV QNG shown separately."],
        ["Open complaint age", "Now (data pull) minus complaint created time", "-", "complaints_open", "-", "RCI 4 hours",
         "open at data pull", "complaint", ""],
        ["Consignment age", "Data pull time minus arrival time", "-", "forward_open", "-", "6 hours", "open at data pull", "consignment",
         "Priority (P0, P1, P2) is the live value from the source, not derived."],
        ["Unload percent / putaway percent", "Units unloaded / units put away", "Units expected (open consignments)", "forward_open", "-", "none given",
         "open at data pull", "consignment", ""],
        ["DN short / DN damage", "Sum DN line value by type", "-", "forward_dn", "forward (confirmed)", "-", mtd, "consignment x item", ""],
        ["Crate attributable OpenDN", "Crate attributable open DN value", "Open DN value", "forward_crates", "-", "directional only",
         "at data pull", "store", f"Shown only when scan adherence >= {CRATE_SCAN_ADHERENCE_MIN_PCT:g}% and no consignment open past 6h; otherwise 'not usable yet'."],
        ["RSTO / RTS open documents", "Document value by state (open billed, open dispatch, DN short)", "-", "reverse_open (warehouse_etls.all_reverse_consignment_raw)",
         "reverse (inferred)", "-", "open at data pull", "document", "Source access denied: greyed until access is granted."],
    ]
    keys = ["metric", "numerator", "denominator", "denominator_source", "head_assignment", "threshold", "window", "grain", "caveat"]
    return [dict(zip(keys, r)) for r in rows]


# -------------------------------------------------------------------------------------
# HTML assembly
# -------------------------------------------------------------------------------------

def build_payload(sources, master, win, generated_at, sample, mode_desc):
    ctx = Ctx(sources, master, win, generated_at)
    stores = {oid: build_store(oid, ctx) for oid in ALLOWLIST}
    checks = run_checks(sources, stores, master, ctx, generated_at)
    cms = {}
    for oid, st in stores.items():
        label = st["cm"] if st["cm_status"] == "assigned" else ("CM unassigned" if st["cm_status"] == "unassigned" else "CM missing from store master")
        cms.setdefault(label, []).append(oid)
    cm_list = [{"cm": k, "stores": sorted(v, key=lambda o: stores[o]["sort_key"])} for k, v in sorted(cms.items(), key=lambda kv: (kv[0].startswith("CM "), kv[0]))]
    src_meta = {}
    for k, s in sources.items():
        limit = QUERIES.get(k, {}).get("stale_hours") or STALENESS_LIMIT_HOURS
        age_h = (generated_at - s.retrieved_at).total_seconds() / 3600 if s.retrieved_at else None
        src_meta[k] = {"label": SOURCE_LABELS[k], "charter": RESULT_SETS[k]["charter"], "status": s.status,
                       "error": s.error, "retrieved_at": s.retrieved_at.strftime("%Y-%m-%d %H:%M IST") if s.retrieved_at else None,
                       "retrieved_note": s.retrieved_note, "age_hours": age_h,
                       "stale": bool(age_h is not None and age_h > limit), "stale_limit_hours": limit,
                       "rows": int(len(s.df)) if s.ok else 0, "optional": bool(RESULT_SETS[k].get("optional_source"))}
    oldest = min((s.retrieved_at for s in sources.values() if s.ok and s.retrieved_at), default=None)
    newest = max((s.retrieved_at for s in sources.values() if s.ok and s.retrieved_at), default=None)
    meta = {
        "generated_at": generated_at.strftime("%Y-%m-%d %H:%M:%S IST"),
        "oldest_pull": oldest.strftime("%Y-%m-%d %H:%M:%S IST") if oldest else None,
        "newest_pull": newest.strftime("%Y-%m-%d %H:%M:%S IST") if newest else None,
        "windows": win.as_dict(), "sample": sample, "mode": mode_desc,
        "spark_dates": [d.isoformat() for d in win.days(win.spark_start, win.report_date)],
        "denominator": DENOMINATOR, "thresholds": THRESHOLDS, "trend": TREND,
        "incident_min_rupees": INCIDENT_MIN_RUPEES, "new_store_days": NEW_STORE_DAYS,
        "crate_scan_min_pct": CRATE_SCAN_ADHERENCE_MIN_PCT, "staleness_hours": STALENESS_LIMIT_HOURS,
        "store_master": master["path"], "clusters": {c: len(v) for c, v in CLUSTERS.items()},
        "head_assignment": {hk: [{"component": COMPONENT_LABELS[col], "status": st, "in_total": it}
                                 for col, _s, st, it in h["components"]] for hk, h in HEADS.items()},
    }
    return {"meta": meta, "sources": src_meta, "checks": checks, "cms": cm_list, "stores": stores,
            "order": [o for c in cm_list for o in c["stores"]], "definitions": definitions(win)}


def render_html(payload, echarts_js):
    data = json.dumps(clean_json(payload), separators=(",", ":"), ensure_ascii=False)
    data = data.replace("</", "<\\/")
    page = TEMPLATE.replace("/*__ECHARTS__*/", echarts_js.replace("</script", "<\\/script"))
    return page.replace("/*__DATA__*/null", data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv-dir", help="read <charter_key>.csv files from this folder instead of Redash")
    ap.add_argument("--store-master", help="path to stores.csv or store-master.md")
    ap.add_argument("--out", default=None, help=f"output path (default: ./{OUTPUT_FILENAME})")
    ap.add_argument("--report-date", help="window end date YYYY-MM-DD (default: yesterday IST)")
    ap.add_argument("--refresh", action="store_true", help="Redash: ask for a fresh run (max_age 0) instead of the stored result")
    ap.add_argument("--json-out", help="also write the computed payload as JSON (for checking)")
    args = ap.parse_args(argv)

    base_dir = Path(__file__).resolve().parent
    generated_at = dt.datetime.now(IST)
    if args.report_date:
        report_date = dt.date.fromisoformat(args.report_date)
    elif REPORT_DATE:
        report_date = REPORT_DATE
    else:
        report_date = generated_at.date() - dt.timedelta(days=1)
    win = Windows.build(report_date)

    master = load_store_master(args.store_master, [Path.cwd(), base_dir])
    sources = load_sources(args, base_dir)
    sample = bool(args.csv_dir and (Path(args.csv_dir) / "_SAMPLE").exists())
    mode_desc = f"CSV: {args.csv_dir}" if args.csv_dir else f"Redash: {os.environ.get('REDASH_URL', '')}"
    payload = build_payload(sources, master, win, generated_at, sample, mode_desc)

    echarts_path = base_dir / ECHARTS_PATH
    if not echarts_path.exists():
        sys.exit(f"{echarts_path} not found. See README.md (vendor ECharts).")
    html_out = render_html(payload, echarts_path.read_text(encoding="utf-8"))
    out = Path(args.out) if args.out else Path.cwd() / OUTPUT_FILENAME
    out.write_text(html_out, encoding="utf-8")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(clean_json(payload), indent=1, ensure_ascii=False), encoding="utf-8")

    failing = [c for c in payload["checks"] if not c["ok"]]
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    print(f"stores: {len(payload['stores'])}; report date {win.report_date}; sample={sample}")
    for k, s in payload["sources"].items():
        print(f"  {k:<20} {s['status']:<15} rows={s['rows']:<6} retrieved={s['retrieved_at']}{'  STALE' if s['stale'] else ''}")
    print("checks: all passing" if not failing else f"checks: {len(failing)} failing")
    for c in failing:
        print(f"  FAIL {c['name']}")
        for d in c["detail"][:8]:
            print(f"       {d}")
        if len(c["detail"]) > 8:
            print(f"       ... {len(c['detail']) - 8} more")
    return 0 if not failing else 2


TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UK SM Worklist</title>
<style>
:root{
  --ink:#1b1b1b; --ink2:#4a4a4a; --muted:#6b6b6b; --line:#d9d9d6; --line2:#ececea;
  --bg:#ffffff; --panel:#f7f7f5; --link:#1d4f7a;
  --alert:#c4161c; --alert-ink:#ffffff;
  --det-fill:#3a3a3a; --det-ink:#ffffff;
  --chr-fill:#dcdcd8; --chr-ink:#1b1b1b;
  --grey-bg:#efefed; --grey-ink:#6b6b6b;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.4;-webkit-text-size-adjust:100%}
.num,td.n,th.n{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
a{color:var(--link)}
button{font:inherit}
header.top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px}
.top-row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.title{font-weight:700;font-size:16px;white-space:nowrap}
#storeSel{font:inherit;font-size:15px;padding:6px 8px;max-width:100%;min-width:240px;border:1px solid var(--ink2);border-radius:4px;background:#fff}
.hdr-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--ink2);margin-top:6px}
.hdr-meta b{color:var(--ink)}
.banner-sample{background:#1b1b1b;color:#fff;padding:8px 16px;font-weight:700;letter-spacing:.02em}
.strip{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:6px 16px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}
.strip button{border:1px solid var(--ink2);background:#fff;border-radius:4px;padding:3px 10px;cursor:pointer}
.strip .ok{font-weight:600}
.strip .fail{font-weight:700}
#checksPanel{padding:8px 16px 12px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}
#checksPanel ul{margin:4px 0 8px 18px;padding:0}
main{padding:12px 16px 40px;max-width:1400px;margin:0 auto}
h2{font-size:16px;margin:18px 0 6px}
h3{font-size:14px;margin:14px 0 4px}
.sub{color:var(--muted);font-size:12px}
.win{color:var(--ink2);font-size:12px;margin:0 0 6px}
.panel{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:10px 0;background:#fff}
.panel-h{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;align-items:baseline}
.panel-h h3{margin:0}
.src{font-size:11px;color:var(--muted)}
.greyed{background:var(--grey-bg);color:var(--grey-ink);border:1px dashed #b5b5b0;border-radius:6px;padding:10px 12px;margin:8px 0;
  background-image:repeating-linear-gradient(135deg,transparent 0 8px,rgba(0,0,0,.035) 8px 16px)}
.greyed b{color:#444}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:3px;white-space:nowrap;vertical-align:middle}
.chip.BROKEN{background:var(--alert);color:var(--alert-ink)}
.chip.DETERIORATING{background:var(--det-fill);color:var(--det-ink)}
.chip.CHRONIC{background:var(--chr-fill);color:var(--chr-ink)}
.chip.NO_DATA{background:#fff;color:var(--ink);border:1px dashed var(--ink)}
.chip.CLEAN{display:none}
.chip.flag{background:#fff;color:var(--ink);border:1px solid var(--ink)}
.dir{display:inline-block;width:1.1em;text-align:center;font-weight:700;color:var(--ink)}
.new{font-weight:700;color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:8px 0}
.card{border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:#fff;cursor:pointer;min-width:0;overflow:hidden}
.card:hover{border-color:var(--ink2)}
.card.BROKEN{border:2px solid var(--alert)}
.card-h{font-size:12px;color:var(--ink2);display:flex;justify-content:space-between;gap:6px}
.card-v{display:flex;align-items:center;gap:6px;margin:2px 0}
.big{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.card-s{font-size:11px;color:var(--muted)}
.spark{height:34px;width:100%}
.chart{width:100%;height:220px}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;margin:4px 0}
.kv div b{font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--ink2);margin-top:18px;overflow-x:auto;position:sticky;top:var(--hdr-h,0px);background:var(--bg);z-index:10}
.tabs button{border:1px solid var(--line);border-bottom:none;background:var(--panel);padding:8px 12px;cursor:pointer;border-radius:5px 5px 0 0;white-space:nowrap;color:var(--ink2)}
.tabs button.on{background:#fff;color:var(--ink);font-weight:700;border-color:var(--ink2);position:relative;top:1px}
.tabpanel{display:none}
.tabpanel.on{display:block}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line2);border-radius:4px;margin:6px 0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:5px 8px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
th{background:var(--panel);font-weight:600;font-size:12px;color:var(--ink2);position:sticky;top:0;white-space:nowrap}
th.sortable{cursor:pointer}
th.sortable:after{content:" \2195";color:#aaa}
tbody tr:hover{background:#fafaf8}
td.first,th.first{position:sticky;left:0;background:inherit}
tbody td.first{background:#fff}
tr.cmrow td{background:var(--panel);font-weight:700;border-top:2px solid var(--line)}
td.todo{min-width:220px}
table.cm td.first{min-width:150px}
table.cm td.first a{font-weight:600}
.clickable{cursor:pointer}
.clickable:hover{background:#f3f3ef}
.legend{font-size:12px;color:var(--ink2);display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.actions button{border:1px solid var(--ink2);background:#fff;border-radius:4px;padding:6px 12px;cursor:pointer}
.note{font-size:12px;color:var(--ink2);margin:4px 0}
.integrity{border:2px solid var(--ink);padding:8px 10px;border-radius:6px;margin:8px 0;font-size:13px}
.empty{color:var(--muted);font-style:italic;padding:6px 0}
.small{font-size:12px}
details summary{cursor:pointer}
.print-only{display:none}
@media (max-width:640px){
  header.top{position:static}
  .tabs{top:0}
  main{padding:10px 16px 40px}
  .big{font-size:21px}
  #storeSel{min-width:0;width:100%}
  .chart{height:200px}
}
@page{size:A4 landscape;margin:10mm}
@media print{
  header.top{position:static}
  .banner-sample{background:none;color:#000;border:2px solid #000}
  .card,.spark,.chart{overflow:hidden}
  .spark svg,.chart svg{max-width:100%}
  table{font-size:10px}
  th,td{padding:3px 5px}
  td.todo{min-width:0}
  th.sortable:after{content:""}
  .kv{font-size:11px}
  #storeSel,.strip button,.tabs,.actions,#checksPanel,.no-print{display:none !important}
  .print-only{display:block}
  .tabpanel{display:block !important;page-break-before:always}
  .tablewrap{overflow:visible;border:none}
  th{position:static}
  td.first,th.first{position:static}
  tr{page-break-inside:avoid}
  .card{break-inside:avoid}
  body{font-size:11px}
  .chip.BROKEN{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .chip.DETERIORATING,.chip.CHRONIC{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>
</head>
<body>
<header class="top" id="hdr">
  <div class="top-row">
    <div class="title">UK SM Worklist</div>
    <select id="storeSel" aria-label="Store"></select>
  </div>
  <div class="hdr-meta" id="hdrMeta"></div>
</header>
<div id="sampleBanner" class="banner-sample" hidden>SAMPLE DATA. Generated test data, not real. Do not act on these numbers.</div>
<div class="strip" id="strip"></div>
<div id="checksPanel" hidden></div>
<main id="view"></main>
<script>/*__ECHARTS__*/</script>
<script>
"use strict";
const D = /*__DATA__*/null;
const M = D.meta, TH = M.thresholds, DEN = M.denominator;
const STATE_TEXT = {BROKEN:"BROKEN",DETERIORATING:"DETERIORATING",CHRONIC:"CHRONIC",CLEAN:"",NO_DATA:"NO DATA"};
const DIR_GLYPH = {up:"↑",down:"↓",flat:"-"};
const TAB_LABELS = [["variance","Variance"],["wastage","Wastage and expiry"],["complaints","Complaints"],["forward","Forward and transfer"],["reverse","Reverse"],["definitions","Definitions"]];
let current = {store:null, tab:"variance"};
let charts = [];

/* ---------- formatting ---------- */
function esc(s){return s==null?"":String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function isNum(v){return typeof v==="number" && isFinite(v);}
function rs(v){if(!isNum(v))return "-";const n=Math.round(v);return (n<0?"-":"")+"Rs "+Math.abs(n).toLocaleString("en-IN");}
function po(v){return isNum(v)?v.toFixed(2):"-";}
function pct(v,d){return isNum(v)?v.toFixed(d==null?1:d)+"%":"-";}
function intf(v){return isNum(v)?Math.round(v).toLocaleString("en-IN"):"-";}
function qty(v){return isNum(v)?(Math.abs(v-Math.round(v))<1e-9?Math.round(v).toLocaleString("en-IN"):v.toFixed(1)):"-";}
function hrs(v){return isNum(v)?v.toFixed(1)+"h":"-";}
function days(v){return isNum(v)?v.toFixed(1)+"d":"-";}
function mins(v){return isNum(v)?Math.round(v)+" min":"-";}
function dd(s){if(!s)return "-";const d=new Date(s+"T00:00:00");return isNaN(d)?s:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"});}
function chip(state){if(!state||state==="CLEAN")return "";return `<span class="chip ${state}">${STATE_TEXT[state]}</span>`;}
function dirg(dir){if(dir==null)return `<span class="dir" title="trend not computable">?</span>`;return `<span class="dir" title="direction: ${dir}">${DIR_GLYPH[dir]}</span>`;}
function flag(t){return `<span class="chip flag">${esc(t)}</span>`;}
function denomText(n,window){return `÷ ${intf(n)} ${esc(DEN.short)}${window?" ("+window+")":""}`;}
function storeName(st){return (st.name||"name missing from store master")+(st.is_new?" ◇":"");}
function cmName(st){return st.cm_status==="assigned"?st.cm:(st.cm_status==="unassigned"?"CM unassigned":"CM missing from store master");}
const W = M.windows;
const MTD = `MTD ${dd(W.mtd_start)} to ${dd(W.report_date)}`;

/* ---------- source status ---------- */
const STATUS_TEXT = {
  pending_access:"Source pending access",
  missing:"Data missing",
  not_configured:"Data missing: query not configured",
  error:"Source error",
  absent:"This store is absent from the result set"
};
function srcLine(key){const s=D.sources[key];if(!s)return "";
  return `<span class="src">source: ${esc(key)}${s.retrieved_at?", retrieved "+esc(s.retrieved_at):""}${s.stale?" <b>STALE</b>":""}</span>`;}
function greyed(key,status){const s=D.sources[key]||{};
  let why = STATUS_TEXT[status]||status;
  let extra = status==="absent" ? "Not a clean store: no rows for this outlet." : (s.error?esc(s.error):"");
  return `<div class="greyed"><b>${esc(why)}</b> (${esc(key)}: ${esc(s.label||"")}). ${extra}</div>`;}
function block(key,status,fn){return status==="ok"?fn():greyed(key,status);}

/* ---------- tables ---------- */
let tableSeq=0; const tableStore={};
function table(cols,rows,opts){
  opts=opts||{};
  const id="t"+(tableSeq++);
  tableStore[id]={cols,rows,opts,sort:opts.sort||null};
  return `<div class="tablewrap"><table id="${id}">${tableInner(id)}</table></div>`;
}
function tableInner(id){
  const {cols,rows,opts,sort}=tableStore[id];
  let r=rows.slice();
  if(sort){const c=cols.find(c=>c.k===sort.k);const get=c.sortv||(x=>x[c.k]);
    r.sort((a,b)=>{const va=get(a),vb=get(b);if(va==null&&vb==null)return 0;if(va==null)return 1;if(vb==null)return -1;
      return (va<vb?-1:va>vb?1:0)*(sort.dir);});}
  let h="<thead><tr>"+cols.map((c,i)=>`<th class="${c.n?"n ":""}${i===0?"first ":""}${c.nosort?"":"sortable"}" data-t="${id}" data-k="${c.k}">${esc(c.h)}</th>`).join("")+"</tr></thead>";
  if(!r.length){return h+`<tbody><tr><td colspan="${cols.length}" class="empty">${esc(opts.empty||"No open items in the data.")}</td></tr></tbody>`;}
  let b="<tbody>"+r.map(x=>"<tr"+(opts.rowAttr?opts.rowAttr(x):"")+">"+cols.map((c,i)=>`<td class="${c.n?"n ":""}${i===0?"first ":""}${c.cls||""}">${c.f?c.f(x):esc(x[c.k]==null?"-":x[c.k])}</td>`).join("")+"</tr>").join("")+"</tbody>";
  return h+b;
}
document.addEventListener("click",e=>{
  const th=e.target.closest("th.sortable");if(!th)return;
  const id=th.dataset.t,k=th.dataset.k,t=tableStore[id];if(!t)return;
  t.sort = (t.sort&&t.sort.k===k)?{k,dir:-t.sort.dir}:{k,dir:(t.cols.find(c=>c.k===k).n?-1:1)};
  document.getElementById(id).innerHTML=tableInner(id);
});

/* ---------- charts ---------- */
function chartSlot(cls,optionFn){const id="c"+charts.length;charts.push({id,optionFn,inst:null});return `<div class="${cls}" id="${id}"></div>`;}
function initCharts(){
  if(typeof echarts==="undefined")return;
  charts.forEach(c=>{const el=document.getElementById(c.id);if(!el)return;
    if(c.inst){if(el.offsetWidth>0)c.inst.resize();return;}
    if(el.offsetWidth===0)return;
    c.inst=echarts.init(el,null,{renderer:"svg"});c.inst.setOption(c.optionFn());});
}
function disposeCharts(){charts.forEach(c=>{if(c.inst)c.inst.dispose();});charts=[];}
window.addEventListener("resize",()=>charts.forEach(c=>c.inst&&c.inst.resize()));
window.addEventListener("beforeprint",()=>{document.body.classList.add("printing");initCharts();charts.forEach(c=>c.inst&&c.inst.resize());});
const INK="#1b1b1b", GREY="#9a9a96";
function sp(vals){return (vals||[]).map((v,i)=>[M.spark_dates[i],v]);}
function sparkOpt(points,thr,fmt){
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const mx=Math.max(thr||0,...ys.filter(isNum));
  return {animation:false,grid:{left:1,right:1,top:3,bottom:1},
    xAxis:{type:"category",data:xs,show:false},yAxis:{type:"value",show:false,min:0,max:mx*1.12||1},
    tooltip:{trigger:"axis",confine:true,formatter:p=>`${dd(p[0].axisValue)}: ${isNum(p[0].value)?fmt(p[0].value):"no data"}`},
    series:[{type:"line",data:ys,symbol:"none",lineStyle:{width:1.5,color:INK},connectNulls:false,
      markLine:thr==null?undefined:{silent:true,symbol:"none",label:{show:false},lineStyle:{type:"dashed",color:GREY,width:1},data:[{yAxis:thr}]}}]};
}
function lineOpt(points,thr,fmt,name){
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  return {animation:false,grid:{left:40,right:12,top:16,bottom:28},
    xAxis:{type:"category",data:xs,axisLabel:{formatter:v=>dd(v),fontSize:10,color:"#555"},axisLine:{lineStyle:{color:"#bbb"}}},
    yAxis:{type:"value",min:0,axisLabel:{fontSize:10,color:"#555"},splitLine:{lineStyle:{color:"#eee"}}},
    tooltip:{trigger:"axis",confine:true,formatter:p=>`${dd(p[0].axisValue)}: ${isNum(p[0].value)?fmt(p[0].value):"no data"}`},
    series:[{name,type:"line",data:ys,symbol:"circle",symbolSize:4,lineStyle:{width:1.5,color:INK},itemStyle:{color:INK},connectNulls:false,
      markLine:thr==null?undefined:{silent:true,symbol:"none",lineStyle:{type:"dashed",color:"#777",width:1},label:{formatter:"threshold "+fmt(thr),fontSize:10,color:"#555",position:"insideEndTop"},data:[{yAxis:thr}]}}]};
}
function barOpt(labels,values,highlightIdx,unit){
  return {animation:false,grid:{left:40,right:12,top:16,bottom:28},
    xAxis:{type:"category",data:labels,axisLabel:{fontSize:10,color:"#555"},axisLine:{lineStyle:{color:"#bbb"}}},
    yAxis:{type:"value",minInterval:1,axisLabel:{fontSize:10,color:"#555"},splitLine:{lineStyle:{color:"#eee"}}},
    tooltip:{trigger:"axis",confine:true,formatter:p=>`${p[0].axisValue}: ${isNum(p[0].value)?p[0].value:"no data"} ${unit}`},
    series:[{type:"bar",data:values.map((v,i)=>({value:v,itemStyle:{color:i===highlightIdx?INK:"#a9a9a4",decal:i===highlightIdx?{symbol:"rect",dashArrayX:[1,0],dashArrayY:[3,3],rotation:-0.785,color:"rgba(255,255,255,0.35)"}:null}})),
      barMaxWidth:44,label:{show:true,position:"top",fontSize:10,color:"#333"}}],aria:{enabled:true,decal:{show:false}}};
}
function svgSpark(points,thr){
  const ys=points.map(p=>p[1]);const v=ys.filter(isNum);if(!v.length)return `<span class="sub">no data</span>`;
  const w=70,h=18,mx=Math.max(thr||0,...v)*1.1||1;const step=w/Math.max(1,ys.length-1);
  let d="",pen=false;ys.forEach((y,i)=>{if(!isNum(y)){pen=false;return;}const X=(i*step).toFixed(1),Y=(h-y/mx*h).toFixed(1);d+=(pen?"L":"M")+X+" "+Y+" ";pen=true;});
  const ty=thr!=null?(h-thr/mx*h).toFixed(1):null;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${ty!=null?`<line x1="0" x2="${w}" y1="${ty}" y2="${ty}" stroke="#aaa" stroke-dasharray="2 2" stroke-width="1"/>`:""}<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.3"/></svg>`;
}

/* ---------- header, strip ---------- */
function buildSelector(){
  const sel=document.getElementById("storeSel");
  let h=`<option value="">All stores: CM view (${Object.keys(D.stores).length})</option>`;
  D.cms.forEach(g=>{h+=`<optgroup label="${esc(g.cm)}">`+g.stores.map(id=>{const st=D.stores[id];return `<option value="${id}">${esc(storeName(st))} (${id})</option>`;}).join("")+"</optgroup>";});
  sel.innerHTML=h;
  sel.addEventListener("change",()=>go(sel.value?Number(sel.value):null,current.tab));
}
function renderHeader(){
  const el=document.getElementById("hdrMeta");
  const win=`Window: ${MTD} (IST, D-1); open lists as at data pull`;
  const pull=`Data pulled: ${esc(M.oldest_pull||"no data")}${M.newest_pull&&M.newest_pull!==M.oldest_pull?" to "+esc(M.newest_pull):""}`;
  if(current.store==null){
    el.innerHTML=`<span><b>CM view</b>, ${Object.keys(D.stores).length} stores, ${Object.entries(M.clusters).map(([c,n])=>esc(c)+" "+n).join(", ")}</span><span>${pull}</span><span>${win}</span><span class="sub">Generated ${esc(M.generated_at)}; ${esc(M.mode)}</span>`;
  }else{
    const st=D.stores[current.store];
    el.innerHTML=`<span>Store <b>${esc(storeName(st))}</b>, outlet <b>${st.id}</b></span><span>CM <b>${esc(cmName(st))}</b></span><span>Cluster <b>${esc(st.cluster)}</b></span>`+
      `<span>Go-live ${st.go_live?esc(st.go_live)+" ("+st.age_days+" days)":"not in store master"}${st.is_new?" <b>◇ under "+M.new_store_days+" days, reads noisy</b>":""}</span>`+
      `${st.type?`<span>Type ${esc(st.type)}</span>`:""}${st.mode?`<span>Mode ${esc(st.mode)}</span>`:""}<span>${pull}</span><span>${win}</span>`;
  }
  const hdr=document.getElementById("hdr");
  document.documentElement.style.setProperty("--hdr-h",(getComputedStyle(hdr).position==="sticky"?hdr.offsetHeight:0)+"px");
}
function renderStrip(){
  const failing=D.checks.filter(c=>!c.ok);
  const s=document.getElementById("strip");
  s.innerHTML=(failing.length?`<span class="fail">${failing.length} failing</span> of ${D.checks.length} data checks`:`<span class="ok">All checks passing</span> (${D.checks.length} data checks)`)+
    `<button id="chkBtn" aria-expanded="false">${failing.length?"Show failing":"Show checks"}</button><span class="sub">Stale or missing data is listed here; a store absent from a source is never shown as clean.</span>`;
  const p=document.getElementById("checksPanel");
  let h="<b>Data control checks</b><ul>"+D.checks.map(c=>`<li>${c.ok?"PASS":"<b>FAIL</b>"}: ${esc(c.name)}`+
    (c.detail.length?"<ul>"+c.detail.slice(0,60).map(d=>`<li>${esc(d)}</li>`).join("")+(c.detail.length>60?`<li>... ${c.detail.length-60} more</li>`:"")+"</ul>":"")+
    (c.info.length?"<ul>"+c.info.map(d=>`<li class="sub">info: ${esc(d)}</li>`).join("")+"</ul>":"")+"</li>").join("")+"</ul>";
  h+="<b>Sources</b>"+table([
    {k:"key",h:"Result set"},{k:"label",h:"What"},{k:"status",h:"Status",f:x=>x.status==="ok"?"ok":`<b>${esc(STATUS_TEXT[x.status]||x.status)}</b>`},
    {k:"retrieved_at",h:"Retrieved"},{k:"age_hours",h:"Age",n:1,f:x=>hrs(x.age_hours)},{k:"stale",h:"Fresh",f:x=>x.status!=="ok"?"-":(x.stale?`<b>STALE</b> (limit ${x.stale_limit_hours}h)`:"ok")},
    {k:"rows",h:"Rows",n:1,f:x=>intf(x.rows)},{k:"retrieved_note",h:"Timestamp from"},{k:"error",h:"Note"}],
    Object.entries(D.sources).map(([k,v])=>Object.assign({key:k},v)));
  p.innerHTML=h;
  document.getElementById("chkBtn").addEventListener("click",e=>{p.hidden=!p.hidden;e.target.setAttribute("aria-expanded",String(!p.hidden));});
}
function legend(){
  return `<div class="legend"><span>${chip("BROKEN")} at or above threshold, RCA required</span><span>${chip("DETERIORATING")} below, rising fast, call-out only</span>`+
  `<span>${chip("CHRONIC")} below, stable, persistently high, monthly</span><span>CLEAN: not shown. Under threshold is not fine, only not urgent; zero is the target.</span>`+
  `<span>Direction: <b>↑</b> rising <b>↓</b> falling <b>-</b> stable <b>?</b> trend not computable</span><span><b>◇</b> store under ${M.new_store_days} days from go-live, reads noisy</span>`+
  `<span>${chip("NO_DATA")} data missing; never read as clean</span></div>`;
}
function trendParams(){
  const t=M.trend;
  return `<div class="note"><b>Trend parameters (heuristic, uncalibrated):</b> trailing ${t.trailing_days} days (${dd(W.trailing_start)} to ${dd(W.trailing_end)}) vs baseline ${t.baseline_days} days (${dd(W.baseline_start)} to ${dd(W.baseline_end)}); rise ${t.rise_pct}% marks a direction; deteriorating and chronic need at least ${t.min_share_of_threshold_pct}% of threshold. `+
  (M.incident_min_rupees!=null?`Single events of ${rs(M.incident_min_rupees)} or more are excluded from the trend and listed as incidents (author default, confirm).`:"Incident exclusion off.")+` Level uses the full ${MTD} figure.</div>`;
}

/* ---------- CM view ---------- */
function metricCell(st,m,tab,fmt){
  if(!m)return `<span class="sub">no data</span>`;
  return `<a href="#s=${st.id}&t=${tab}" class="mc">${fmt(m.judged!=null?m.judged:m.per_order)}</a> ${dirg(m.dir)} ${chip(m.state)}`;
}
function renderCM(){
  let h=`<h2>Stores by exception (CM view)</h2><p class="win">Each CM's stores sorted by state (no data, broken, deteriorating, chronic) then by level as a share of its threshold. Never ranked on rupees. Per-order figures: ${MTD}, per ${esc(DEN.short)}. Click a store or a figure to open its worklist.</p>`+legend();
  const cols=[["Total","total",TH.total],["In-store","in_store",TH.in_store],["Forward","forward",TH.forward],["Reverse","reverse",TH.reverse],["Returns, refunds","returns_refunds",TH.returns_refunds]];
  h+=`<div class="tablewrap"><table class="cm"><thead><tr><th class="first">Store</th>`+cols.map(c=>`<th class="n">${c[0]}<br><span class="sub">vs ${po(c[2])}</span></th>`).join("")+
    `<th>Trend (total, 30d)</th><th class="n">Open variance<br><span class="sub">vs ${po(TH.open_variance)}</span></th><th class="n">Complaints D-1<br><span class="sub">vs ${TH.complaint_pct}%</span></th><th>Top exception</th></tr></thead><tbody>`;
  D.cms.forEach(g=>{
    h+=`<tr class="cmrow"><td class="first" colspan="${cols.length+5}">${esc(g.cm)} (${g.stores.length})</td></tr>`;
    g.stores.forEach(id=>{const st=D.stores[id],s=st.summary;
      const ok=s.status==="ok";
      const ex=st.exceptions[0];
      h+=`<tr class="clickable" data-store="${id}"><td class="first"><a href="#s=${id}&t=variance">${esc(storeName(st))}</a><br><span class="sub">${id}, ${esc(st.cluster)}</span></td>`+
        cols.map(c=>`<td class="n">${ok?metricCell(st,c[1]==="total"?s.total:s.heads[c[1]],c[1]==="total"?"variance":(s.heads[c[1]]||{}).tab,po):chip("NO_DATA")}</td>`).join("")+
        `<td>${ok?svgSpark(sp(s.total.spark),TH.total):chip("NO_DATA")}</td>`+
        `<td class="n">${st.variance.open_status==="ok"?`<a href="#s=${id}&t=variance">${po(st.variance.open_per_order)}</a> ${chip(st.variance.open_state)}`:`<span class="sub">${esc(STATUS_TEXT[st.variance.open_status]||st.variance.open_status)}</span>`}</td>`+
        `<td class="n">${st.complaints.daily_status==="ok"?`<a href="#s=${id}&t=complaints">${pct(st.complaints.d1.pct,2)}</a> ${dirg(st.complaints.dir)} ${chip(st.complaints.state)}`:`<span class="sub">${esc(STATUS_TEXT[st.complaints.daily_status]||st.complaints.daily_status)}</span>`}</td>`+
        `<td>${ex?`<a href="#s=${id}&t=${ex.tab==="summary"?"variance":ex.tab}">${chip(ex.state)} ${esc(ex.text)}</a>`+(st.exceptions.length>1?` <span class="sub">+${st.exceptions.length-1} more</span>`:""):`<span class="sub">no exception</span>`}</td></tr>`;
    });
  });
  h+="</tbody></table></div>";
  return h;
}

/* ---------- store summary ---------- */
function compTab(key,headTab){if(key.startsWith("manual_"))return "variance";if(key==="bsd"||key==="bse"||key==="bsnte")return "wastage";return headTab;}
function summaryHTML(st){
  const s=st.summary;
  if(s.status!=="ok")return `<h2>Store summary</h2>`+greyed("loss_daily",s.status);
  const cards=[["total","Total loss per order",s.total,"variance"]].concat(Object.entries(s.heads).map(([k,m])=>[k,m.label+" per order",m,m.tab]));
  let h=`<h2>Store summary</h2><p class="win">${MTD}, IST, D-1. Per-order denominator: ${esc(DEN.short)} (${esc(DEN.column)}), ${intf(s.orders_mtd)} over ${s.days_mtd} day(s). ${srcLine("loss_daily")}</p>`;
  h+=`<div class="cards">`+cards.map(([k,label,m,tab])=>{
    const second = m.central_per_order==null ? `<div class="card-s">second source: ${s.central_status==="ok"?"none for this store":"not loaded"}</div>` :
      `<div class="card-s">${m.judged_source==="central"?`central ${po(m.central_per_order)} shown; computed ${po(m.per_order)} (lower)`:`computed shown; central ${po(m.central_per_order)}${m.central_per_order<m.per_order?" (lower)":""}`}</div>`;
    return `<div class="card ${m.state}" data-tab="${tab}" role="button" tabindex="0"><div class="card-h"><span>${esc(label)}</span><span>vs ${po(m.threshold)}</span></div>`+
      `<div class="card-v"><span class="big">${po(m.judged)}</span>${dirg(m.dir)}${chip(m.state)}</div>`+
      `<div class="card-s">${rs(m.rupees)} ${denomText(s.orders_mtd,"MTD")}</div>`+second+
      chartSlot("spark",()=>sparkOpt(sp(m.spark),m.threshold,po))+
      `<div class="card-s">trailing ${po(m.trailing)} | baseline ${po(m.baseline)} (ex incidents)</div></div>`;
  }).join("")+`</div>`;
  const fr=s.fresh, ft=s.forward_in_transit;
  h+=`<div class="kv"><div>Fresh, outside the total as central does: FNV <b>${rs(fr.fnv_rupees)}</b> (${po(fr.fnv_per_order)} per order), Milk <b>${rs(fr.milk_rupees)}</b> (${po(fr.milk_per_order)} per order)</div></div>`;
  h+=`<div class="kv"><div>Forward in transit (open billed + open dispatch, stays in forward): <b>${rs(ft.rupees)}</b>; forward minus in transit <b>${po(ft.forward_minus_in_transit_per_order)}</b> per order</div>`+
     `<div>CRWI (separate line, not netted from reverse): <b>${rs(s.crwi.rupees)}</b> (${po(s.crwi.per_order)} per order)</div></div>`;
  const idt=s.identity;
  h+=`<div class="note">Identity: total ${rs(idt.formula)} = in-store + forward + reverse (without RTS short) + returns and refunds ${rs(idt.heads_in_total)}: <b>${idt.ok?"holds":"DOES NOT HOLD"}</b>. RTS short ${rs(idt.rts_short_outside_total)} sits in the reverse head (inferred) but not in the total formula.</div>`;
  if(s.null_components&&s.null_components.length)h+=`<div class="note"><b>Null in source, counted as 0:</b> ${s.null_components.map(esc).join(", ")}</div>`;
  h+=`<details class="panel"><summary><b>Head breakdown</b> (component, rupees, per order, head assignment)</summary>`+table(
    [{k:"head",h:"Head"},{k:"label",h:"Component"},{k:"rupees",h:"Rupees",n:1,f:x=>rs(x.rupees)},{k:"per_order",h:"Per order",n:1,f:x=>po(x.per_order)},
     {k:"status",h:"Assignment",f:x=>x.status==="confirmed"?"confirmed":"<b>inferred</b>"},{k:"in_total",h:"In total formula",f:x=>x.in_total?"yes":"<b>no</b>"},
     {k:"tab",h:"Act in",f:x=>`<a href="#s=${st.id}&t=${x.tab}">${esc(x.tabLabel)}</a>`}],
    Object.entries(s.heads).flatMap(([k,m])=>m.components.map(c=>Object.assign({head:m.label,tab:compTab(c.key,m.tab),tabLabel:(TAB_LABELS.find(t=>t[0]===compTab(c.key,m.tab))||[])[1]},c))))+
    `<p class="note">Live variance (manual negative minus manual positive, MTD) ${rs(s.live_variance.rupees)} is part of in-store. It is a different series from open variance on the Variance tab; the two are never compared.</p></details>`;
  h+=trendParams();
  if(s.incidents_status==="ok"){
    h+=`<details class="panel"${s.incidents.length?" open":""}><summary><b>Incidents</b> (${s.incidents.length}) single events of ${rs(M.incident_min_rupees)} or more, ${dd(W.baseline_start)} to ${dd(W.report_date)}, excluded from trend only</summary>`+
      table([{k:"dt",h:"Date",f:x=>dd(x.dt)},{k:"head",h:"Head"},{k:"component",h:"Component"},{k:"item_name",h:"Item"},{k:"ref_id",h:"Reference"},{k:"rupees",h:"Rupees",n:1,f:x=>rs(x.rupees)}],s.incidents,{empty:"No single event at or above the incident size."})+`</details>`;
  }else if(s.incidents_status!=="off"){
    h+=greyed("loss_events",s.incidents_status).replace("</div>"," Trend includes all events.</div>");
  }
  return h;
}

/* ---------- tabs ---------- */
function varianceHTML(st){
  const v=st.variance, s=st.summary;
  let h=`<div class="panel"><div class="panel-h"><h3>Open variance by item</h3>${srcLine("variance_open")}</div><p class="win">Open at data pull. Open variance, not live (MTD) variance: separate series, never compared. Investigated first regardless of rupee size.</p>`;
  h+=block("variance_open",v.open_status,()=>{
    let x=`<div class="kv"><div>Open variance <b>${rs(v.open_rupees)}</b> ${denomText(s.orders_mtd,"MTD")} = <b>${po(v.open_per_order)}</b> per order vs ${po(TH.open_variance)} ${chip(v.open_state)}</div>`+
      `<div>FNV <b>${rs(v.open_fnv_rupees)}</b></div><div>Non-FNV <b>${rs(v.open_non_fnv_rupees)}</b></div><div>Items <b>${v.items.length}</b></div></div>`+
      `<div class="kv small"><div>Matched nearby: ${v.disc_counts.MATCHED+v.disc_counts.MATCHED_AND_INWARD}</div><div>Offsetting inward: ${v.disc_counts.CORRECTION}</div><div>Unmatched short: ${v.disc_counts.UNMATCHED}</div><div>Unclassified: ${v.disc_counts.UNCLASSIFIED}</div></div>`;
    x+=table([{k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}<br><span class="sub">${esc(r.item_id)}</span>`},{k:"is_fnv",h:"FNV",f:r=>r.is_fnv?"FNV":""},
      {k:"qty",h:"Qty",n:1,f:r=>qty(r.qty)},{k:"rupees",h:"Rupees",n:1,f:r=>rs(r.rupees)},{k:"negative_location",h:"Negative location"},
      {k:"probable_locations",h:"Probable locations"},{k:"discriminator",h:"Discriminator",f:r=>r.disc_code==="UNCLASSIFIED"?`<span class="sub">unclassified</span>`:esc(r.discriminator)+(r.nearby_long_locations?`<br><span class="sub">long at ${esc(r.nearby_long_locations)}</span>`:"")},
      {k:"last_auditor",h:"Last auditor"},{k:"last_audit_ts",h:"Last audit"},{k:"days_open",h:"Days open",n:1,f:r=>days(r.days_open)},
      {k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],v.items,{sort:{k:"rupees",dir:-1},empty:"No open variance items for this store in the data."});
    return x;});
  h+=`</div><div class="panel"><div class="panel-h"><h3>Pending audits (location, item, expiry)</h3>${srcLine("audit_pending")}</div><p class="win">Assigned to this store, open at data pull.</p>`;
  h+=block("audit_pending",v.audit_status,()=>table([{k:"audit_type",h:"Type"},{k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}<br><span class="sub">${esc(r.item_id||"")}</span>`},
      {k:"location",h:"Location"},{k:"who",h:"Auditor"},{k:"created_ts",h:"Created"},{k:"due_ts",h:"Due"},
      {k:"overdue",h:"Overdue",f:r=>r.overdue?flag("OVERDUE"):""},{k:"age_hours",h:"Age",n:1,f:r=>hrs(r.age_hours)},{k:"todo",h:"What to do",cls:"todo"}],v.audits,{empty:"No pending audits in the data."}));
  h+=`</div><div class="panel"><div class="panel-h"><h3>Auditor quality</h3>${srcLine("auditor_quality")}</div>`;
  h+=block("auditor_quality",v.auditor_status,()=>{
    let x=`<p class="win">${v.auditor_window?`${dd(v.auditor_window[0])} to ${dd(v.auditor_window[1])}`:"window: no rows"}. Each point is one auditor-day: audit seconds per unit touched (recomputed from components). `+
      (v.min_line!=null?`Minimum-audit-time line ${v.min_line} s/unit (${esc(v.min_line_source)}); points below it are flagged with a triangle.`:`<b>Minimum-audit-time line not set</b> (CONFIG MIN_AUDIT_SEC_PER_UNIT); no point flagged.`)+` Input accuracy target ${TH.auditor_accuracy_pct}%.</p>`;
    if(v.auditor_points.length){x+=chartSlot("chart",()=>{
      const pts=v.auditor_points.filter(p=>isNum(p.sec_per_unit));
      const mk=(below)=>pts.filter(p=>p.below_line===below).map(p=>({value:[p.units,p.sec_per_unit],name:p.auditor,dt:p.dt}));
      return {animation:false,grid:{left:46,right:14,top:34,bottom:42},
        xAxis:{type:"value",name:"units touched",nameLocation:"middle",nameGap:24,nameTextStyle:{fontSize:11},axisLabel:{fontSize:10},splitLine:{lineStyle:{color:"#eee"}}},
        yAxis:{type:"value",name:"sec per unit",nameTextStyle:{fontSize:11,align:"left"},axisLabel:{fontSize:10},splitLine:{lineStyle:{color:"#eee"}}},
        tooltip:{confine:true,formatter:p=>`${esc(p.data.name)}, ${dd(p.data.dt)}<br>${qty(p.value[0])} units, ${p.value[1].toFixed(1)} s/unit${p.seriesIndex===1?"<br><b>below minimum line</b>":""}`},
        legend:{top:0,right:0,textStyle:{fontSize:11},data:["at or above line","below line"]},
        series:[{name:"at or above line",type:"scatter",symbol:"circle",symbolSize:7,itemStyle:{color:"#a9a9a4"},data:mk(false),
          markLine:v.min_line==null?undefined:{silent:true,symbol:"none",lineStyle:{type:"dashed",color:INK},label:{formatter:"minimum "+v.min_line+" s/unit",fontSize:10,position:"insideStartTop"},data:[{yAxis:v.min_line}]}},
          {name:"below line",type:"scatter",symbol:"triangle",symbolSize:10,itemStyle:{color:INK},data:mk(true)}]};});}
    x+=table([{k:"auditor",h:"Auditor"},{k:"days",h:"Days",n:1},{k:"units",h:"Units",n:1,f:r=>intf(r.units)},{k:"sec_per_unit",h:"Sec per unit",n:1,f:r=>isNum(r.sec_per_unit)?r.sec_per_unit.toFixed(1):"-"},
      {k:"below_line_days",h:"Days below line",n:1,f:r=>r.below_line_days?`<b>${r.below_line_days}</b> ${flag("BELOW LINE")}`:"0"},
      {k:"accuracy_pct",h:"Input accuracy",n:1,f:r=>`${pct(r.accuracy_pct,1)}${r.accuracy_below_target?" "+flag("BELOW 100%"):""}<br><span class="sub">${intf(r.correct)} of ${intf(r.inputs)} inputs</span>`}],v.auditors,{empty:"No auditor rows in the data."});
    return x;});
  h+=`</div>`;
  return h;
}
function wastageHTML(st){
  const w=st.wastage;
  let h=`<div class="panel"><div class="panel-h"><h3>Task closure, dump marking, dump value</h3>${srcLine("wastage_daily")}</div><p class="win">${MTD}, IST, D-1.</p>`;
  h+=block("wastage_daily",w.daily_status,()=>{
    let x="";
    if(w.negative_wastage.length){x+=`<div class="integrity"><b>Data integrity issue: negative wastage</b> (${w.negative_wastage.length} occurrence(s)). Not an ops issue; raise with the data owner.<ul>`+w.negative_wastage.slice(0,12).map(n=>`<li>${dd(n.dt)} ${esc(n.column)} = ${qty(n.value)}</li>`).join("")+`</ul></div>`;}
    const c=w.closure,m=w.marking;
    x+=`<div class="cards"><div class="card ${c.state}" style="cursor:default"><div class="card-h"><span>NTE and expiry task closure</span><span>floor ${TH.nte_expiry_closure_pct}%</span></div><div class="card-v"><span class="big">${pct(c.pct)}</span>${chip(c.state)}</div>`+
      `<div class="card-s">${intf(c.closed)} closed of ${intf(c.created)} created. NTE ${pct(c.nte_pct)} (${intf(c.nte_closed)}/${intf(c.nte_created)}), expiry ${pct(c.expiry_pct)} (${intf(c.expiry_closed)}/${intf(c.expiry_created)})</div>`+chartSlot("spark",()=>sparkOpt(sp(c.spark),TH.nte_expiry_closure_pct,v=>pct(v)))+`</div>`+
      `<div class="card ${m.state}" style="cursor:default"><div class="card-h"><span>Dump marking compliance</span><span>floor ${TH.dump_marking_pct}%</span></div><div class="card-v"><span class="big">${pct(m.pct)}</span>${chip(m.state)}</div>`+
      `<div class="card-s">${intf(m.marked)} marked of ${intf(m.eligible)} eligible dump lines</div>`+chartSlot("spark",()=>sparkOpt(sp(m.spark),TH.dump_marking_pct,v=>pct(v)))+`</div></div>`;
    const cols=[["non_fresh","Non-fresh (in total)"],["fnv","FNV"],["milk","Milk"],["total","All"]];
    x+=`<div class="tablewrap"><table><thead><tr><th class="first">${MTD}</th>`+cols.map(c=>`<th class="n">${c[1]}</th>`).join("")+`</tr></thead><tbody>`+
      `<tr><td class="first">Dump value</td>`+cols.map(c=>`<td class="n">${rs(w.dump[c[0]])}</td>`).join("")+`</tr>`+
      `<tr><td class="first">Sales value (denominator)</td>`+cols.map(c=>`<td class="n">${rs(w.sales[c[0]])}</td>`).join("")+`</tr>`+
      `<tr><td class="first">Dump % of sales</td>`+cols.map(c=>`<td class="n"><b>${pct(w.dump_pct[c[0]],2)}</b></td>`).join("")+`</tr></tbody></table></div>`;
    return x;});
  h+=`</div><div class="panel"><div class="panel-h"><h3>NTE and expiry tasks still open</h3>${srcLine("wastage_open_tasks")}</div><p class="win">Open at data pull.</p>`;
  h+=block("wastage_open_tasks",w.tasks_status,()=>table([{k:"task_type",h:"Type"},{k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}<br><span class="sub">${esc(r.item_id||"")}</span>`},
    {k:"is_fnv",h:"FNV",f:r=>r.is_fnv?"FNV":""},{k:"is_milk",h:"Milk",f:r=>r.is_milk?"Milk":""},{k:"location",h:"Location"},{k:"qty",h:"Qty",n:1,f:r=>qty(r.qty)},{k:"rupees",h:"Rupees",n:1,f:r=>rs(r.rupees)},
    {k:"age_hours",h:"Age",n:1,f:r=>hrs(r.age_hours)},{k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],w.tasks,{empty:"No open NTE or expiry tasks in the data."}));
  h+=`</div><div class="panel"><div class="panel-h"><h3>Near expiry, not yet actioned</h3>${srcLine("near_expiry")}</div><p class="win">At data pull. Days left counted from ${dd(W.report_date)}.</p>`;
  h+=block("near_expiry",w.near_status,()=>table([{k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}<br><span class="sub">${esc(r.item_id||"")}</span>`},
    {k:"is_fnv",h:"FNV",f:r=>r.is_fnv?"FNV":""},{k:"is_milk",h:"Milk",f:r=>r.is_milk?"Milk":""},{k:"location",h:"Location"},{k:"qty",h:"Qty",n:1,f:r=>qty(r.qty)},{k:"rupees",h:"Rupees",n:1,f:r=>rs(r.rupees)},
    {k:"expiry_date",h:"Expiry",f:r=>dd(r.expiry_date)},{k:"days_to_expiry",h:"Days left",n:1},{k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],w.near,{sort:{k:"days_to_expiry",dir:1},empty:"No unactioned near-expiry items in the data."}));
  h+=`</div>`;
  return h;
}
function complaintsHTML(st){
  const c=st.complaints, s=st.summary;
  let h=`<div class="panel"><div class="panel-h"><h3>Complaint percent</h3>${srcLine("complaints_daily")}</div><p class="win">Level: D-1 (${dd(W.report_date)}). Numerator COUNT(DISTINCT external_complaint_id). Denominator ${esc(DEN.short)}, same day.</p>`;
  h+=block("complaints_daily",c.daily_status,()=>{
    let x=`<div class="kv"><div>D-1 <b class="big">${pct(c.d1.pct,2)}</b> ${dirg(c.dir)} ${chip(c.state)} vs ${TH.complaint_pct}%<br><span class="sub">${intf(c.d1.complaints)} complaints ${denomText(c.d1.orders)}</span></div>`+
      `<div>${MTD} <b>${pct(c.mtd.pct,2)}</b><br><span class="sub">${intf(c.mtd.complaints)} ${denomText(c.mtd.orders)}</span></div><div>trailing ${pct(c.trailing,2)} | baseline ${pct(c.baseline,2)}</div></div>`;
    x+=chartSlot("chart",()=>lineOpt(sp(c.spark),TH.complaint_pct,v=>pct(v,2),"complaint %"));
    x+=`<h3>By type, ${MTD}</h3>`+table([{k:"label",h:"Type"},{k:"priority",h:"Priority",f:r=>r.priority||"-"},{k:"count",h:"Complaints (distinct)",n:1,f:r=>intf(r.count)},{k:"pct",h:"% of orders",n:1,f:r=>pct(r.pct,2)}],c.types,{empty:"no types"});
    x+=`<div class="kv"><div>FNV QNG (shown separately): <b>${intf(c.qng_fnv.count)}</b> complaints, ${pct(c.qng_fnv.share_of_qng_pct)} of QNG, ${pct(c.qng_fnv.pct_of_orders,2)} of orders</div></div>`;
    x+=`<div class="note">Returns and refunds head (refund, bad returns, LIT): <b>${s.status==="ok"?po(s.heads.returns_refunds.judged):"-"}</b> per order vs ${po(TH.returns_refunds)} ${s.status==="ok"?chip(s.heads.returns_refunds.state):""}, ${MTD}.</div>`;
    return x;});
  h+=`</div><div class="panel"><div class="panel-h"><h3>Open complaints</h3>${srcLine("complaints_open")}</div><p class="win">Open at data pull. Age against the RCI ${TH.rci_hours}-hour standard.</p>`;
  h+=block("complaints_open",c.open_status,()=>table([{k:"complaint_id",h:"Complaint"},{k:"order_id",h:"Order"},{k:"complaint_type",h:"Type"},{k:"priority",h:"Priority",f:r=>r.priority||"-"},
    {k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}${r.item_id?`<br><span class="sub">${esc(r.item_id)}</span>`:""}`},{k:"is_fnv",h:"FNV",f:r=>r.is_fnv?"FNV":""},{k:"picker",h:"Picker",f:r=>esc(r.picker||"not in data")},
    {k:"age_hours",h:"Age",n:1,f:r=>`${hrs(r.age_hours)}${r.past_rci?" "+flag("PAST 4h"):""}`},{k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],c.open,{sort:{k:"age_hours",dir:-1},empty:"No open complaints in the data."}));
  h+=`</div>`;
  return h;
}
function forwardHTML(st){
  const f=st.forward,s=st.summary;
  let h=`<div class="panel"><div class="panel-h"><h3>Forward loss</h3>${srcLine("loss_daily")}</div><p class="win">${MTD}, IST, D-1.</p>`;
  if(s.status==="ok"){const m=s.heads.forward,ft=s.forward_in_transit;
    const comp=k=>m.components.find(c=>c.key===k)||{};
    h+=`<div class="kv"><div>Forward <b class="big">${po(m.judged)}</b> ${dirg(m.dir)} ${chip(m.state)} per order vs ${po(TH.forward)}<br><span class="sub">${rs(m.rupees)} ${denomText(s.orders_mtd,"MTD")}</span></div>`+
      `<div>DN other ${rs(comp("dn_other").rupees)}<br>NR ${rs(comp("nr").rupees)}<br>Open DN short ${rs(comp("open_dn_short").rupees)}</div><div>ESTO credit ${rs(-(comp("esto").rupees||0))} (netted against forward)</div>`+
      `<div>In transit ${rs(ft.rupees)}<br>Forward minus in transit <b>${po(ft.forward_minus_in_transit_per_order)}</b> per order</div></div>`;
  }else h+=greyed("loss_daily",s.status);
  h+=`</div><div class="panel"><div class="panel-h"><h3>Consignments open now</h3>${srcLine("forward_open")}</div><p class="win">Open at data pull. Age from arrival. Priority is the live value from source.</p>`;
  h+=block("forward_open",f.open_status,()=>{
    let x=`<div class="kv"><div>Unload <b>${pct(f.unload_pct)}</b> vs putaway <b>${pct(f.putaway_pct)}</b><br><span class="sub">${intf(f.units_unloaded)} and ${intf(f.units_putaway)} of ${intf(f.units_expected)} units expected on open consignments</span></div>`+
      `<div>GRN putaway pending <b>${intf(f.grn_putaway_pending_units)}</b> units</div><div>Past 6h <b>${f.past_6h_count}</b> ${f.past_6h_count?flag("PAST 6h"):""}</div></div>`;
    const labels=Object.keys(f.age_buckets);if(f.open.length)x+=`<h3>Open consignments by age</h3>`+chartSlot("chart",()=>barOpt(labels,labels.map(l=>f.age_buckets[l]),labels.length-1,"consignments"));
    x+=table([{k:"priority",h:"Priority",f:r=>r.priority||"-",sortv:r=>({P0:0,P1:1,P2:2}[r.priority]??9)},{k:"consignment_id",h:"Consignment"},{k:"source_name",h:"From"},{k:"status",h:"Status"},
      {k:"age_minutes",h:"Age",n:1,f:r=>`${mins(r.age_minutes)}${r.past_6h?" "+flag("PAST 6h"):""}`},{k:"units_expected",h:"Expected",n:1,f:r=>intf(r.units_expected)},{k:"units_unloaded",h:"Unloaded",n:1,f:r=>intf(r.units_unloaded)},
      {k:"units_putaway",h:"Put away",n:1,f:r=>intf(r.units_putaway)},{k:"grn_pending_units",h:"GRN putaway pending",n:1,f:r=>intf(r.grn_pending_units)},{k:"rupees",h:"Rupees",n:1,f:r=>rs(r.rupees)},
      {k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],f.open,{empty:"No open consignments in the data."});
    return x;});
  h+=`</div><div class="panel"><div class="panel-h"><h3>DN short and DN damage</h3>${srcLine("forward_dn")}</div><p class="win">${MTD}, by consignment.</p>`;
  h+=block("forward_dn",f.dn_status,()=>`<div class="kv"><div>DN short <b>${rs(f.dn_short_rupees)}</b> (FNV ${rs(f.dn_short_fnv_rupees)})</div><div>DN damage <b>${rs(f.dn_damage_rupees)}</b> (FNV ${rs(f.dn_damage_fnv_rupees)})</div></div>`+
    table([{k:"dn_type",h:"Type"},{k:"consignment_id",h:"Consignment"},{k:"item_name",h:"Item",f:r=>`${esc(r.item_name||"-")}<br><span class="sub">${esc(r.item_id||"")}</span>`},{k:"is_fnv",h:"FNV",f:r=>r.is_fnv?"FNV":""},
      {k:"qty",h:"Qty",n:1,f:r=>qty(r.qty)},{k:"rupees",h:"Rupees",n:1,f:r=>rs(r.rupees)},{k:"dt",h:"Date",f:r=>dd(r.dt)},{k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],f.dn,{sort:{k:"rupees",dir:-1},empty:"No DN short or damage lines in the window."}));
  h+=`</div><div class="panel"><div class="panel-h"><h3>Crate attributable OpenDN (directional only)</h3>${srcLine("forward_crates")}</div>`;
  h+=block("forward_crates",f.crates_status,()=>{const c=f.crates;if(!c)return `<div class="empty">No crate row.</div>`;
    let x=`<div class="kv"><div>Precondition 1, scanning adherence about 100%: <b>${pct(c.scan_adherence_pct)}</b> (${intf(c.scans_done)} of ${intf(c.scans_expected)} scans; need ${M.crate_scan_min_pct}%) ${c.pre_scan_ok?"met":flag("NOT MET")}</div>`+
      `<div>Precondition 2, no consignment open past 6h: ${c.pre_no_consignment_past_6h==null?"<b>unknown</b> (forward_open missing)":c.pre_no_consignment_past_6h?"met":flag("NOT MET")}</div>`+
      `<div>Crate attributable share of open DN: <b>${c.usable?pct(c.crate_attrib_pct)+" ("+rs(c.crate_attrib_rupees)+" of "+rs(c.open_dn_rupees)+")":"not usable yet"}</b></div></div>`;
    const labels=Object.keys(c.age_buckets);x+=`<h3>Crate age at store</h3>`+chartSlot("chart",()=>barOpt(labels,labels.map(l=>c.age_buckets[l]),labels.length-1,"crates"));
    return x;});
  h+=`</div>`;
  return h;
}
function reverseHTML(st){
  const r=st.reverse,s=st.summary;
  let h=`<div class="panel"><div class="panel-h"><h3>Reverse loss (gross)</h3>${srcLine("loss_daily")}</div><p class="win">${MTD}, IST, D-1. Variance and RSTO are separate books; no rupee crosses between them.</p>`;
  if(s.status==="ok"){const m=s.heads.reverse;
    h+=`<div class="kv"><div>Reverse <b class="big">${po(m.judged)}</b> ${dirg(m.dir)} ${chip(m.state)} per order vs ${po(TH.reverse)}<br><span class="sub">${rs(m.rupees)} gross ${denomText(s.orders_mtd,"MTD")}</span></div>`+
      `<div>CRWI, separate visible line, not netted: <b>${rs(s.crwi.rupees)}</b> (${po(s.crwi.per_order)} per order)</div></div>`+
      table([{k:"label",h:"Component"},{k:"rupees",h:"Rupees",n:1,f:x=>rs(x.rupees)},{k:"per_order",h:"Per order",n:1,f:x=>po(x.per_order)},
        {k:"status",h:"Head assignment",f:x=>x.status==="confirmed"?"confirmed":"<b>inferred</b>"},{k:"in_total",h:"In total formula",f:x=>x.in_total?"yes":"<b>no</b>"}],m.components);
  }else h+=greyed("loss_daily",s.status);
  h+=`</div><div class="panel"><div class="panel-h"><h3>RSTO and RTS open documents</h3>${srcLine("reverse_open")}</div><p class="win">Open at data pull: open billed, open dispatch, DN short. Age from document creation.</p>`;
  h+=block("reverse_open",r.open_status,()=>table([{k:"label",h:"Type and state"},{k:"docs",h:"Documents",n:1},{k:"rupees",h:"Rupees",n:1,f:x=>rs(x.rupees)},{k:"fnv_rupees",h:"FNV rupees",n:1,f:x=>rs(x.fnv_rupees)}],r.totals,{empty:"No open documents in the data."})+
    table([{k:"doc_type",h:"Type"},{k:"doc_id",h:"Document"},{k:"state",h:"State"},{k:"destination",h:"Destination"},{k:"qty",h:"Qty",n:1,f:x=>qty(x.qty)},{k:"rupees",h:"Rupees",n:1,f:x=>rs(x.rupees)},
      {k:"fnv_rupees",h:"FNV rupees",n:1,f:x=>rs(x.fnv_rupees)},{k:"age_days",h:"Age",n:1,f:x=>days(x.age_days)},{k:"todo",h:"What to do",cls:"todo"},{k:"who",h:"Who"}],r.open,{sort:{k:"age_days",dir:-1},empty:"No open documents in the data."}));
  h+=`</div>`;
  return h;
}
function definitionsHTML(){
  let h=`<div class="panel"><h3>Definitions</h3><p class="win">One row per metric. Every per-order figure uses ${esc(DEN.short)} (${esc(DEN.column)}): ${esc(DEN.definition)}</p>`;
  h+=table([{k:"metric",h:"Metric"},{k:"numerator",h:"Numerator"},{k:"denominator",h:"Denominator"},{k:"denominator_source",h:"Denominator source"},
    {k:"head_assignment",h:"Head assignment"},{k:"threshold",h:"Threshold"},{k:"window",h:"Window"},{k:"grain",h:"Grain"},{k:"caveat",h:"Known caveat"}],D.definitions,{});
  h+=`<h3>Head assignment</h3>`+table([{k:"head",h:"Head"},{k:"component",h:"Component"},{k:"status",h:"Assignment",f:x=>x.status==="confirmed"?"confirmed":"<b>inferred</b>"},{k:"in_total",h:"In total formula",f:x=>x.in_total?"yes":"<b>no</b>"}],
    Object.entries(M.head_assignment).flatMap(([h,l])=>l.map(c=>Object.assign({head:h},c))));
  h+=`<h3>Active parameters</h3><div class="note">Thresholds: total ${TH.total}, in-store ${TH.in_store}, forward ${TH.forward}, reverse ${TH.reverse}, returns and refunds ${TH.returns_refunds} per order; open variance ${TH.open_variance} per order; complaints ${TH.complaint_pct}%; NTE/expiry closure floor ${TH.nte_expiry_closure_pct}%; dump marking floor ${TH.dump_marking_pct}%; auditor accuracy ${TH.auditor_accuracy_pct}%; RCI ${TH.rci_hours}h; consignment ${TH.consignment_open_hours}h.</div>`+trendParams()+
    `<div class="note">Staleness limit ${M.staleness_hours}h (author default, confirm). Crate scan adherence ${M.crate_scan_min_pct}% (author default for "about 100%", confirm). Store master: ${esc(M.store_master||"not found")}.</div></div>`;
  return h;
}

/* ---------- store view ---------- */
function renderStore(id){
  const st=D.stores[id];
  let h=`<p class="print-only"><b>${esc(storeName(st))} (${st.id})</b>, CM ${esc(cmName(st))}, ${esc(st.cluster)}. Data pulled ${esc(M.oldest_pull||"-")}. ${MTD}.</p>`;
  h+=legend()+summaryHTML(st);
  h+=`<div class="actions no-print"><button id="csvBtn">Export this store's worklist (CSV)</button><button id="printBtn">Print store view</button><button id="backBtn">All stores (CM view)</button></div>`;
  h+=`<nav class="tabs" role="tablist">`+TAB_LABELS.map(([k,l])=>`<button role="tab" data-tab="${k}" class="${k===current.tab?"on":""}">${l}${badge(st,k)}</button>`).join("")+`</nav>`;
  const fns={variance:varianceHTML,wastage:wastageHTML,complaints:complaintsHTML,forward:forwardHTML,reverse:reverseHTML,definitions:()=>definitionsHTML()};
  h+=TAB_LABELS.map(([k,l])=>`<section class="tabpanel ${k===current.tab?"on":""}" data-panel="${k}"><h2 class="print-only">${l}</h2>${fns[k](st)}</section>`).join("");
  return h;
}
function badge(st,tab){
  const n={variance:(st.variance.items||[]).length,wastage:(st.wastage.tasks||[]).length+(st.wastage.near||[]).length,complaints:(st.complaints.open||[]).length,forward:(st.forward.open||[]).length,reverse:(st.reverse.open||[]).length}[tab];
  const bad=st.exceptions.some(e=>e.tab===tab&&e.state==="BROKEN");
  return n==null?"":` <span class="sub">(${n})</span>${bad?" "+chip("BROKEN").replace("BROKEN</span>","!</span>"):""}`;
}

/* ---------- CSV export ---------- */
function worklistRows(st){
  const out=[];const add=(tab,section,flagv,o)=>out.push(Object.assign({tab,section,flag:flagv||""},o));
  (st.variance.items||[]).forEach(r=>add("Variance","Open variance",r.discriminator,{item_id:r.item_id,item:r.item_name,fnv:r.is_fnv?"FNV":"",location:r.negative_location,qty:r.qty,rupees:r.rupees,age:r.days_open!=null?r.days_open.toFixed(1)+" d":"",ref:"",todo:r.todo,who:r.who}));
  (st.variance.audits||[]).forEach(r=>add("Variance","Pending audit",(r.overdue?"OVERDUE ":"")+r.audit_type,{item_id:r.item_id,item:r.item_name,location:r.location,qty:"",rupees:"",age:r.age_hours!=null?r.age_hours.toFixed(1)+" h":"",ref:r.task_id,todo:r.todo,who:r.who}));
  (st.wastage.tasks||[]).forEach(r=>add("Wastage","Open task",r.task_type,{item_id:r.item_id,item:r.item_name,fnv:r.is_fnv?"FNV":(r.is_milk?"Milk":""),location:r.location,qty:r.qty,rupees:r.rupees,age:r.age_hours!=null?r.age_hours.toFixed(1)+" h":"",ref:r.task_id,todo:r.todo,who:r.who}));
  (st.wastage.near||[]).forEach(r=>add("Wastage","Near expiry",r.days_to_expiry!=null?r.days_to_expiry+" days left":"",{item_id:r.item_id,item:r.item_name,fnv:r.is_fnv?"FNV":(r.is_milk?"Milk":""),location:r.location,qty:r.qty,rupees:r.rupees,age:"",ref:r.expiry_date,todo:r.todo,who:r.who}));
  (st.complaints.open||[]).forEach(r=>add("Complaints","Open complaint",(r.past_rci?"PAST 4h ":"")+(r.priority||""),{item_id:r.item_id,item:r.item_name,fnv:r.is_fnv?"FNV":"",location:"",qty:"",rupees:"",age:r.age_hours!=null?r.age_hours.toFixed(1)+" h":"",ref:r.complaint_id+" / order "+(r.order_id||""),todo:r.todo,who:r.who}));
  (st.forward.open||[]).forEach(r=>add("Forward","Open consignment",(r.past_6h?"PAST 6h ":"")+(r.priority||""),{item_id:"",item:"",location:"",qty:r.units_expected,rupees:r.rupees,age:r.age_minutes!=null?Math.round(r.age_minutes)+" min":"",ref:r.consignment_id,todo:r.todo,who:r.who}));
  (st.forward.dn||[]).forEach(r=>add("Forward","DN "+r.dn_type,"",{item_id:r.item_id,item:r.item_name,fnv:r.is_fnv?"FNV":"",location:"",qty:r.qty,rupees:r.rupees,age:"",ref:r.consignment_id,todo:r.todo,who:r.who}));
  (st.reverse.open||[]).forEach(r=>add("Reverse",r.doc_type+" "+r.state,"",{item_id:"",item:"",location:r.destination,qty:r.qty,rupees:r.rupees,age:r.age_days!=null?r.age_days.toFixed(1)+" d":"",ref:r.doc_id,todo:r.todo,who:r.who}));
  return out;
}
function exportCSV(){
  const st=D.stores[current.store];const rows=worklistRows(st);
  const cols=[["tab","Tab"],["section","Section"],["flag","Flag"],["item_id","Item id"],["item","Item"],["fnv","Fresh"],["location","Location"],["qty","Qty"],["rupees","Rupees"],["age","Age"],["ref","Reference"],["todo","What to do"],["who","Who"]];
  const q=v=>{if(v==null)return "";let s=typeof v==="number"?(Math.round(v*100)/100).toString():String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const head=[`Store,${q(storeName(st))}`,`Outlet,${st.id}`,`CM,${q(cmName(st))}`,`Data pulled,${q(M.oldest_pull||"")}`,`Window,${q(MTD+" IST D-1; lists open at data pull")}`,M.sample?"SAMPLE DATA,not real":"",""].filter((x,i)=>x!==""||i===6);
  const csv="\ufeff"+head.join("\r\n")+"\r\n"+cols.map(c=>c[1]).join(",")+"\r\n"+rows.map(r=>cols.map(c=>q(r[c[0]])).join(",")).join("\r\n")+"\r\n";
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download=`UK worklist ${st.id} ${(st.name||"store").replace(/[^A-Za-z0-9 _-]/g,"")} ${W.report_date}.csv`;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);
}

/* ---------- routing ---------- */
function go(store,tab,noHash){
  current.store=store;current.tab=tab||"variance";
  if(!noHash){const h=store==null?"":`#s=${store}&t=${current.tab}`;if(location.hash!==h)history.replaceState(null,"",h||location.pathname);}
  try{localStorage.setItem("ukws.store",store==null?"":String(store));}catch(e){}
  render();
}
function render(){
  disposeCharts();tableSeq=0;for(const k in tableStore)delete tableStore[k];
  document.getElementById("storeSel").value=current.store==null?"":String(current.store);
  renderHeader();
  const v=document.getElementById("view");
  v.innerHTML=current.store==null?renderCM():renderStore(current.store);
  if(current.store!=null){
    v.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>{current.tab=b.dataset.tab;history.replaceState(null,"",`#s=${current.store}&t=${current.tab}`);
      v.querySelectorAll(".tabs button").forEach(x=>x.classList.toggle("on",x===b));v.querySelectorAll(".tabpanel").forEach(p=>p.classList.toggle("on",p.dataset.panel===current.tab));initCharts();}));
    v.querySelectorAll(".card[data-tab]").forEach(c=>{const f=()=>{const b=v.querySelector(`.tabs button[data-tab="${c.dataset.tab}"]`);if(b){b.click();b.scrollIntoView({block:"start"});}};c.addEventListener("click",f);c.addEventListener("keydown",e=>{if(e.key==="Enter")f();});});
    document.getElementById("csvBtn").addEventListener("click",exportCSV);
    document.getElementById("printBtn").addEventListener("click",()=>window.print());
    document.getElementById("backBtn").addEventListener("click",()=>go(null,current.tab));
  }else{
    v.querySelectorAll("tr[data-store]").forEach(tr=>tr.addEventListener("click",e=>{if(e.target.closest("a"))return;go(Number(tr.dataset.store),"variance");}));
  }
  requestAnimationFrame(initCharts);
}
function fromHash(){
  const m=/s=(\d+)(?:&t=(\w+))?/.exec(location.hash||"");
  if(m&&D.stores[m[1]]){go(Number(m[1]),m[2]||"variance",true);return true;}
  return false;
}
window.addEventListener("hashchange",()=>{if(!fromHash())go(null,"variance",true);});
document.getElementById("sampleBanner").hidden=!M.sample;
buildSelector();renderStrip();
if(!fromHash()){let last=null;try{last=localStorage.getItem("ukws.store");}catch(e){}
  go(last&&D.stores[last]?Number(last):null,"variance");}
</script>
</body>
</html>
"""

if __name__ == "__main__":
    sys.exit(main())
