"""Test-Fixtures: Fake-EEG-Faktura-Server und optionale Test-DB.

Die DB-Tests laufen nur, wenn STROMKREIS_TEST_DATABASE_URL gesetzt ist und
auf eine Datenbank mit angewendeten Plattform-Migrationen zeigt (Wegwerf-
Container, siehe docs/status.md unter "Lokale Entwicklung").
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest


class FakeEegfaktura:
    """Kleiner HTTP-Server mit kannten Antworten je Pfad; zeichnet Requests auf."""

    def __init__(self):
        self.responses = {}  # (method, path) -> (status, payload)
        self.requests = []  # (method, path, headers, body)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                if self.headers.get("Content-Type", "").startswith("application/json"):
                    body = json.loads(raw) if raw else None
                else:
                    body = raw.decode() or None  # z.B. Form-Daten der Token-Anfrage
                outer.requests.append((method, self.path, dict(self.headers), body))
                status, payload = outer.responses.get(
                    (method, self.path), (404, {"error": "not found"})
                )
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_api():
    server = FakeEegfaktura()
    yield server
    server.stop()


@pytest.fixture
def db_conn():
    url = os.environ.get("STROMKREIS_TEST_DATABASE_URL")
    if not url:
        pytest.skip("STROMKREIS_TEST_DATABASE_URL nicht gesetzt")
    psycopg = pytest.importorskip("psycopg")
    conn = psycopg.connect(url)
    yield conn
    conn.rollback()
    with conn.cursor() as cur:
        # Nur Testmandanten aufraeumen (Slug-Praefix), Demo-Seeds bleiben
        cur.execute("select id from tenant where slug like 'pytest-%'")
        for (tenant_id,) in cur.fetchall():
            cur.execute("delete from measurement where tenant_id = %s", (tenant_id,))
            cur.execute("delete from measurement_point where tenant_id = %s", (tenant_id,))
            cur.execute("delete from meter_code where tenant_id = %s", (tenant_id,))
            cur.execute("delete from eegfaktura_source where tenant_id = %s", (tenant_id,))
            cur.execute("delete from tenant where id = %s", (tenant_id,))
    conn.commit()
    conn.close()
