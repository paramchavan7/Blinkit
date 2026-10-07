"""Redash client against a local mock server: stored result, job polling, access denied, HTTP 403."""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import generate_uk_sm_dashboard as g  # noqa: E402

ROWS = [{"outlet_id": 4073, "consignment_id": "CN1", "source_name": "WH", "status": "ARRIVED", "priority": "P0",
         "arrived_ts": "2026-10-07 08:00:00", "units_expected": 10, "units_unloaded": 0, "units_putaway": 0,
         "grn_pending_units": 0, "value": 100.5}]
QR = {"query_result": {"id": 77, "retrieved_at": "2026-10-07T03:30:00.000Z",
                       "data": {"columns": [{"name": k} for k in ROWS[0]], "rows": ROWS}}}


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        Handler.seen.append((self.path, self.headers.get("Authorization"), json.loads(self.rfile.read(n) or b"{}")))
        if self.path == "/api/queries/1/results":
            self._send(200, QR)
        elif self.path == "/api/queries/2/results":
            self._send(200, {"job": {"id": "j2", "status": 1}})
        elif self.path == "/api/queries/3/results":
            self._send(200, {"job": {"id": "j3", "status": 1}})
        elif self.path == "/api/queries/4/results":
            self._send(403, {"message": "forbidden"})
        else:
            self._send(404, {})

    def do_GET(self):
        if self.path == "/api/jobs/j2":
            self._send(200, {"job": {"id": "j2", "status": 3, "query_result_id": 77}})
        elif self.path == "/api/jobs/j3":
            self._send(200, {"job": {"id": "j3", "status": 4, "error": "Access Denied: Cannot select from table warehouse_etls.all_reverse_consignment_raw"}})
        elif self.path == "/api/query_results/77":
            self._send(200, QR)
        else:
            self._send(404, {})


@pytest.fixture(scope="module")
def server():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture
def session():
    import requests
    s = requests.Session()
    s.headers["Authorization"] = "Key test-key"
    s.trust_env = False
    return s


def with_query(qid, monkeypatch, pending=False):
    q = dict(g.QUERIES["forward_open"], id=qid, params={"p": 1}, pending_access=pending)
    monkeypatch.setitem(g.QUERIES, "forward_open", q)


def test_stored_result(server, session, monkeypatch):
    with_query(1, monkeypatch)
    src = g.normalise_source(g.load_redash_source("forward_open", session, server, 3600))
    assert src.status == "ok" and len(src.df) == 1
    assert src.retrieved_at.strftime("%Y-%m-%d %H:%M") == "2026-10-07 09:00"  # 03:30 UTC is 09:00 IST
    path, auth, body = Handler.seen[-1]
    assert auth == "Key test-key" and body == {"parameters": {"p": 1}, "max_age": 3600}


def test_job_polling(server, session, monkeypatch):
    monkeypatch.setattr(g.time, "sleep", lambda s: None)
    with_query(2, monkeypatch)
    src = g.load_redash_source("forward_open", session, server, 0)
    assert src.status == "ok"


def test_access_denied_job_is_pending_access(server, session, monkeypatch):
    monkeypatch.setattr(g.time, "sleep", lambda s: None)
    with_query(3, monkeypatch)
    src = g.load_redash_source("forward_open", session, server, 0)
    assert src.status == "pending_access" and "Access Denied" in src.error


def test_http_403_is_pending_access(server, session, monkeypatch):
    with_query(4, monkeypatch)
    assert g.load_redash_source("forward_open", session, server, 0).status == "pending_access"


def test_pending_in_config_is_not_fetched(server, session, monkeypatch):
    with_query(1, monkeypatch, pending=True)
    before = len(Handler.seen)
    assert g.load_redash_source("forward_open", session, server, 0).status == "pending_access"
    assert len(Handler.seen) == before


def test_unset_query_id_is_not_configured(server, session, monkeypatch):
    with_query(None, monkeypatch)
    assert g.load_redash_source("forward_open", session, server, 0).status == "not_configured"
