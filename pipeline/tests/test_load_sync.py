"""DB-Tests fuer Laden und Sync. Laufen nur mit STROMKREIS_TEST_DATABASE_URL
(Wegwerf-Postgres mit angewendeten Plattform-Migrationen)."""

from datetime import datetime, timezone, timedelta

import pytest

from stromkreis_pipeline.eegfaktura import load, sync
from stromkreis_pipeline.eegfaktura.client import BasicAuth, EegfakturaClient
from stromkreis_pipeline.eegfaktura.config import TenantSource
from stromkreis_pipeline.eegfaktura.normalize import Record

TS = 1767225600000  # 2026-01-01T00:00:00Z
START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_chunk_size_mengenabhaengig():
    # Kleine EEGs: Kappe 30 Tage; grosse: Ziel ~500k Werte je Anfrage; Minimum 1 Tag
    assert sync.chunk_size(0) == timedelta(days=30)
    assert sync.chunk_size(43) == timedelta(days=30)
    assert sync.chunk_size(173) == timedelta(days=30)   # 500000/(173*96) = 30.1
    assert sync.chunk_size(700) == timedelta(days=7)    # ~500 Mitglieder
    assert sync.chunk_size(2000) == timedelta(days=2)
    assert sync.chunk_size(10000) == timedelta(days=1)


@pytest.fixture
def tenant_id(db_conn):
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into tenant (slug, name, latitude, longitude)
            values ('pytest-eeg', 'Pytest EEG', 47.7, 13.6) returning id
            """
        )
        tenant_id = cur.fetchone()[0]
    db_conn.commit()
    return tenant_id


def test_meter_codes_und_upsert_idempotent(db_conn, tenant_id):
    codes = load.ensure_meter_codes(db_conn, tenant_id)
    assert set(codes) == {"total_consumption", "production_share", "self_use", "total_production", "overshoot"}
    assert load.ensure_meter_codes(db_conn, tenant_id) == codes  # zweiter Lauf gleich

    points = load.ensure_measurement_points(
        db_conn, tenant_id, [("AT1", "consumption", "Anna Auer")]
    )
    records = [
        Record("AT1", "consumption", "total_consumption", START, 0.5, 1),
        Record("AT1", "consumption", "self_use", START, 0.2, 2),
    ]
    assert load.upsert_measurements(db_conn, tenant_id, records, points, codes) == 2
    db_conn.commit()

    # Korrigierte Lieferung ueberschreibt Wert und Qualitaet
    records = [Record("AT1", "consumption", "total_consumption", START, 0.6, 1)]
    assert load.upsert_measurements(db_conn, tenant_id, records, points, codes) == 1
    db_conn.commit()

    with db_conn.cursor() as cur:
        cur.execute(
            """
            select m.value, m.quality from measurement m
            join meter_code c on (c.tenant_id, c.id) = (m.tenant_id, m.meter_code_id)
            where m.tenant_id = %s and c.kind = 'total_consumption'
            """,
            (tenant_id,),
        )
        value, quality = cur.fetchone()
    assert float(value) == 0.6 and quality == 1


def test_measurement_point_abgleich_aktualisiert(db_conn, tenant_id):
    ids = load.ensure_measurement_points(db_conn, tenant_id, [("AT1", "consumption", None)])
    ids2 = load.ensure_measurement_points(db_conn, tenant_id, [("AT1", "consumption", "Anna Auer")])
    assert ids == ids2  # gleiche id, kein Duplikat
    with db_conn.cursor() as cur:
        cur.execute(
            "select label from measurement_point where tenant_id = %s and metering_point = 'AT1'",
            (tenant_id,),
        )
        assert cur.fetchone()[0] == "Anna Auer"


def test_sync_tenant_gegen_fake_api(db_conn, tenant_id, fake_api):
    day_ms = 24 * 3600 * 1000
    fake_api.responses[("GET", "/api/master/masterdata")] = (200, [
        {"firstName": "Anna", "lastName": "Auer", "meteringPoint": [
            {"meteringPoint": "AT_V", "direction": "CONSUMPTION"},
        ]},
    ])
    fake_api.responses[("POST", "/energystore/query/RC_TEST/metadata")] = (200, {
        "periodBegin": TS, "periodEnd": TS + day_ms,
    })
    fake_api.responses[("POST", "/energystore/query/rawdata")] = (200, {
        "AT_V": {"direction": "CONSUMPTION", "data": [
            {"ts": TS, "value": [0.5, 0.3, 0.2], "qov": [1, 1, 1]},
            {"ts": TS + 900_000, "value": [0.4, 0.1, 0.1], "qov": [1, 1, 1]},
        ]},
        # Erzeuger fehlt in masterdata und wird aus den Rohdaten angelegt
        "AT_E": {"direction": "GENERATION", "data": [
            {"ts": TS, "value": [1.0, 0.4], "qov": [1, 1]},
        ]},
    })

    source = TenantSource(
        tenant_id=tenant_id, slug="pytest-eeg", rc_number="RC_TEST", community_id=None,
        base_url=fake_api.url, auth_mode="basic", token_url=None, active=True,
    )
    client = EegfakturaClient(source.base_url, source.rc_number, BasicAuth("u", "p"))

    stats = sync.sync_tenant(db_conn, source, client, full=True, pace_seconds=0)
    assert stats.rows == 8  # 2 Intervalle x 3 Kategorien + 1 x 2
    assert stats.chunks == 1
    assert stats.points == 2

    with db_conn.cursor() as cur:
        cur.execute("select count(*) from measurement where tenant_id = %s", (tenant_id,))
        assert cur.fetchone()[0] == 8
        cur.execute(
            "select direction from measurement_point where tenant_id = %s and metering_point = 'AT_E'",
            (tenant_id,),
        )
        assert cur.fetchone()[0] == "generation"
        # Tagesaggregat: 2026-01-01 lokal, je Zaehlpunkt und Kategorie eine Zeile
        cur.execute(
            """
            select p.metering_point, c.kind, d.day::text, d.kwh::float, d.intervals, d.nonzero_intervals
            from measurement_daily d
            join measurement_point p on (p.tenant_id, p.id) = (d.tenant_id, d.measurement_point_id)
            join meter_code c on (c.tenant_id, c.id) = (d.tenant_id, d.meter_code_id)
            where d.tenant_id = %s order by 1, 2
            """,
            (tenant_id,),
        )
        daily = cur.fetchall()
        assert len(daily) == 5
        assert ("AT_V", "total_consumption", "2026-01-01", 0.9, 2, 2) in daily
        assert ("AT_E", "overshoot", "2026-01-01", 0.4, 1, 1) in daily

    # Zweiter Lauf (inkrementell): Fenster ab letztem Wert minus Ueberlappung,
    # gleiche Daten, keine neuen Zeilen
    stats2 = sync.sync_tenant(db_conn, source, client, pace_seconds=0)
    with db_conn.cursor() as cur:
        cur.execute("select count(*) from measurement where tenant_id = %s", (tenant_id,))
        assert cur.fetchone()[0] == 8
    assert stats2.window_start == START + timedelta(minutes=15) - sync.OVERLAP

    share = load.daily_reporting_share(db_conn, tenant_id, START, START + timedelta(days=1))
    assert share == 1.0
