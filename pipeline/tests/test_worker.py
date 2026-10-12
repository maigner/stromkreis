"""DB-Tests fuer den Worker: planmaessiger Import (enqueue_due_syncs, laeuft in
maintenance) und Wiederaufnahme eines Auftrags (resume_since). Laufen nur mit
STROMKREIS_TEST_DATABASE_URL."""

from datetime import datetime, timezone

import pytest

from stromkreis_pipeline import worker
from stromkreis_pipeline.eegfaktura import load, sync
from stromkreis_pipeline.eegfaktura.normalize import Record


@pytest.fixture
def tenant_id(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("insert into tenant (slug, name, latitude, longitude) values ('pytest-worker', 'Pytest Worker', 47.7, 13.6) returning id")
        tenant_id = cur.fetchone()[0]
        cur.execute("insert into member (tenant_id, name, email, role) values (%s, 'Betreiber', 'chef@example.com', 'operator') returning id", (tenant_id,))
        member_id = cur.fetchone()[0]
        cur.execute(
            "insert into eegfaktura_source (tenant_id, rc_number, auth_mode, active) values (%s, 'RC_TEST', 'oidc', true)",
            (tenant_id,),
        )
        cur.execute(
            "insert into eegfaktura_oidc_token (tenant_id, member_id, issuer, client_id, refresh_token_enc) "
            "values (%s, %s, 'https://login.example', 'net.stromkreis.platform', 'enc1:x')",
            (tenant_id, member_id),
        )
    db_conn.commit()
    return tenant_id


def _jobs(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute("select phase, full_import, requested_by from eegfaktura_sync_job where tenant_id = %s order by id", (tenant_id,))
        return cur.fetchall()


def test_enqueue_due_syncs_nur_wenn_faellig(db_conn, tenant_id):
    # Noch kein Auftrag: faellig, inkrementell, ohne Anforderer
    assert worker.enqueue_due_syncs(db_conn) == ["pytest-worker"]
    assert _jobs(db_conn, tenant_id) == [("queued", False, None)]
    # Offener Auftrag: kein zweiter
    assert worker.enqueue_due_syncs(db_conn) == []
    with db_conn.cursor() as cur:
        cur.execute("update eegfaktura_sync_job set phase = 'done', finished_at = now() - interval '2 hours' where tenant_id = %s", (tenant_id,))
    db_conn.commit()
    # Frisch fertig: nicht faellig
    assert worker.enqueue_due_syncs(db_conn) == []
    with db_conn.cursor() as cur:
        cur.execute("update eegfaktura_sync_job set finished_at = now() - interval '25 hours' where tenant_id = %s", (tenant_id,))
    db_conn.commit()
    assert worker.enqueue_due_syncs(db_conn) == ["pytest-worker"]
    assert len(_jobs(db_conn, tenant_id)) == 2
    # Inaktive Quelle: nichts mehr
    with db_conn.cursor() as cur:
        cur.execute("update eegfaktura_sync_job set phase = 'done', finished_at = now() - interval '48 hours' where tenant_id = %s", (tenant_id,))
        cur.execute("update eegfaktura_source set active = false where tenant_id = %s", (tenant_id,))
    db_conn.commit()
    assert worker.enqueue_due_syncs(db_conn) == []


def test_enqueue_due_syncs_ohne_token_nicht(db_conn, tenant_id):
    with db_conn.cursor() as cur:
        cur.execute("delete from eegfaktura_oidc_token where tenant_id = %s", (tenant_id,))
    db_conn.commit()
    assert worker.enqueue_due_syncs(db_conn) == []


def test_resume_since(db_conn, tenant_id):
    assert worker.resume_since(db_conn, tenant_id, {}) is None
    assert worker.resume_since(db_conn, tenant_id, {"rows": 5}) is None
    chunk_end = datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert worker.resume_since(db_conn, tenant_id, {"chunk_end": chunk_end.isoformat()}) == chunk_end - sync.OVERLAP
    # Spaeterer Messwert gewinnt
    codes = load.ensure_meter_codes(db_conn, tenant_id)
    points = load.ensure_measurement_points(db_conn, tenant_id, [("AT1", "consumption", None)])
    later = datetime(2026, 4, 1, tzinfo=timezone.utc)
    load.upsert_measurements(db_conn, tenant_id, [Record("AT1", "consumption", "total_consumption", later, 0.5, 1)], points, codes)
    assert worker.resume_since(db_conn, tenant_id, {"chunk_end": chunk_end.isoformat()}) == later - sync.OVERLAP


def test_claim_job_nimmt_freigegebenen_auftrag_sofort(db_conn, tenant_id):
    with db_conn.cursor() as cur:
        cur.execute(
            "insert into eegfaktura_sync_job (tenant_id, phase, started_at, heartbeat_at, progress) "
            "values (%s, 'energy', now(), now(), '{\"chunk_end\": \"2026-03-01T00:00:00+00:00\"}') returning id",
            (tenant_id,),
        )
        job_id = cur.fetchone()[0]
    db_conn.commit()
    assert worker.claim_job(db_conn) is None  # Heartbeat frisch: gehoert einem anderen Worker
    worker.release_job(db_conn, job_id)
    job = worker.claim_job(db_conn)
    assert job is not None and job["id"] == job_id and job["phase"] == "energy"
    assert job["progress"]["chunk_end"] == "2026-03-01T00:00:00+00:00"
