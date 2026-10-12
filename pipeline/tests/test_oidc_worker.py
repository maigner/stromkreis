"""Tests fuer den OIDC-Weg des Imports: Refresh-Token-Auth, Bearer-Routen,
Teilnehmer-Normalisierung, Mitglieder-Upsert und Worker-Auftrag."""

import os
from datetime import datetime, timezone

import pytest

from stromkreis_pipeline import secrets
from stromkreis_pipeline.eegfaktura import load
from stromkreis_pipeline.eegfaktura.client import EegfakturaClient, EegfakturaError, RefreshTokenAuth
from stromkreis_pipeline.eegfaktura.normalize import normalize_participants

EC = "AT00999900000TC100300000000000000"


@pytest.fixture
def tenant_id(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("insert into tenant (slug, name, latitude, longitude) values ('pytest-oidc', 'Pytest OIDC', 47.7, 13.6) returning id")
        tenant_id = cur.fetchone()[0]
    db_conn.commit()
    return tenant_id


def test_refresh_token_auth_holt_und_rotiert(fake_api):
    fake_api.responses[("POST", "/token")] = (200, {"access_token": "AT1", "expires_in": 300, "refresh_token": "RT2"})
    stored = []
    auth = RefreshTokenAuth(fake_api.url + "/token", "net.stromkreis.platform", "RT1", on_refresh=lambda t, error=None: stored.append((t, error)))
    assert auth.headers() == {"Authorization": "Bearer AT1"}
    assert auth.headers() == {"Authorization": "Bearer AT1"}  # gecacht, kein zweiter Tausch
    assert len([r for r in fake_api.requests if r[1] == "/token"]) == 1
    assert "grant_type=refresh_token" in fake_api.requests[0][3] and "refresh_token=RT1" in fake_api.requests[0][3]
    assert stored == [("RT2", None)]
    assert auth.refresh_token == "RT2"


def test_refresh_token_auth_meldet_fehler(fake_api):
    fake_api.responses[("POST", "/token")] = (400, {"error": "invalid_grant"})
    stored = []
    auth = RefreshTokenAuth(fake_api.url + "/token", "c", "RT1", on_refresh=lambda t, error=None: stored.append((t, error)))
    with pytest.raises(EegfakturaError):
        auth.headers()
    assert stored and stored[0][0] is None and "invalid_grant" in stored[0][1]


def test_bearer_routen(fake_api):
    fake_api.responses[("POST", "/token")] = (200, {"access_token": "AT1", "expires_in": 300})
    fake_api.responses[("GET", f"/energystore/eeg/v2/{EC}/meta")] = (200, {"AT1": {"periodBegin": 1700000000000, "periodEnd": 1700086400000}})
    fake_api.responses[("POST", f"/energystore/eeg/v2/{EC}/raw")] = (200, {"AT1": {"direction": "CONSUMPTION", "data": []}})
    fake_api.responses[("GET", "/api/participant")] = (200, [])
    auth = RefreshTokenAuth(fake_api.url + "/token", "c", "RT1")
    client = EegfakturaClient(fake_api.url, "te100300", auth, ec_id=EC, bearer_routes=True)
    begin, end = client.metadata()
    assert begin < end
    assert client.metadata_points() == ["AT1"]
    payload = client.rawdata(datetime(2023, 11, 14, tzinfo=timezone.utc), datetime(2023, 11, 15, tzinfo=timezone.utc))
    assert "AT1" in payload
    raw_req = [r for r in fake_api.requests if r[1].endswith("/raw")][0]
    assert raw_req[3]["meters"] == ["AT1"] and raw_req[2]["X-Tenant"] == "TE100300" and raw_req[2]["tenant"] == "TE100300"
    assert raw_req[2]["Authorization"] == "Bearer AT1"
    assert client.participants() == []


def test_normalize_participants():
    payload = [{
        "id": "p-1", "participantNumber": "007", "firstname": "Anna", "lastname": "Gruber",
        "contact": {"email": "anna@example.com"},
        "residentAddress": {"street": "Seestrasse", "streetNumber": "3", "zip": "4802", "city": "Ebensee"},
        "meters": [{"meteringPoint": "AT1", "direction": "CONSUMPTION"}, {"meteringPoint": "AT2", "direction": "GENERATION"}, {"direction": "CONSUMPTION"}],
    }, {"id": 2, "firstName": "", "lastName": "", "meters": []}]
    result = normalize_participants(payload)
    assert result[0]["name"] == "Anna Gruber" and result[0]["email"] == "anna@example.com"
    assert result[0]["address"] == "Seestrasse 3, 4802 Ebensee"
    assert result[0]["points"] == [("AT1", "consumption"), ("AT2", "generation")]
    assert result[1]["name"] == "Teilnehmer 2" and result[1]["external_id"] == "2"


def test_secrets_roundtrip(monkeypatch):
    monkeypatch.setenv("TOKEN_SECRET", "ab" * 32)
    enc = secrets.encrypt("geheim")
    assert enc.startswith("enc1:") and secrets.decrypt(enc) == "geheim"


def test_upsert_members_und_zuordnung(db_conn, tenant_id):
    participants = normalize_participants([
        {"id": "p-1", "participantNumber": "001", "firstname": "Anna", "lastname": "Gruber",
         "contact": {"email": "anna@example.com"}, "meters": [{"meteringPoint": "AT1", "direction": "CONSUMPTION"}]},
        {"id": "p-2", "participantNumber": "002", "firstname": "Franz", "lastname": "Huber", "meters": []},
    ])
    assert load.upsert_members(db_conn, tenant_id, participants) == 2
    load.ensure_measurement_points(db_conn, tenant_id, [("AT1", "consumption", "Anna Gruber")])
    load.link_points_to_members(db_conn, tenant_id, participants)
    # Zweiter Lauf: Namensaenderung, keine Duplikate
    participants[0]["name"] = "Anna Gruber-Mayer"
    load.upsert_members(db_conn, tenant_id, participants)
    with db_conn.cursor() as cur:
        cur.execute("select name, email, participant_number, role from member where tenant_id = %s order by participant_number", (tenant_id,))
        rows = cur.fetchall()
        cur.execute("select m.name from measurement_point p join member m on m.tenant_id = p.tenant_id and m.id = p.member_id where p.tenant_id = %s", (tenant_id,))
        linked = cur.fetchall()
    assert [r[0] for r in rows] == ["Anna Gruber-Mayer", "Franz Huber"]
    assert rows[0][1] == "anna@example.com" and rows[0][3] == "member"
    assert linked == [("Anna Gruber-Mayer",)]


def test_upsert_members_geteilte_email_wird_nicht_zusammengelegt(db_conn, tenant_id, caplog):
    """Zwei Teilnehmer mit derselben E-Mail (z.B. Ehepaar) bleiben zwei Zeilen;
    der zweite kommt ohne E-Mail, eine Warnung ohne Adresse im Log."""
    participants = normalize_participants([
        {"id": "p-1", "participantNumber": "001", "firstname": "Anna", "lastname": "Gruber",
         "contact": {"email": "familie@example.com"}, "meters": [{"meteringPoint": "AT1", "direction": "CONSUMPTION"}]},
        {"id": "p-2", "participantNumber": "002", "firstname": "Franz", "lastname": "Gruber",
         "contact": {"email": "Familie@example.com"}, "meters": [{"meteringPoint": "AT2", "direction": "GENERATION"}]},
    ])
    with caplog.at_level("WARNING"):
        assert load.upsert_members(db_conn, tenant_id, participants) == 2
    assert "p-2" in caplog.text and "example.com" not in caplog.text
    # Zweiter Lauf: idempotent, keine Duplikate, keine Zuordnung wechselt
    load.upsert_members(db_conn, tenant_id, participants)
    with db_conn.cursor() as cur:
        cur.execute(
            "select eegfaktura_participant_id, email from member where tenant_id = %s order by participant_number",
            (tenant_id,),
        )
        assert cur.fetchall() == [("p-1", "familie@example.com"), ("p-2", None)]


def test_upsert_members_login_zeile_und_namensabgleich(db_conn, tenant_id):
    """Betreiberzeile aus dem Login (ohne Teilnehmer-ID) bekommt ueber die
    E-Mail die Teilnehmerdaten; eine Zeile mit anderer Teilnehmer-ID wechselt
    nie; Namensabgleich nur fuer Teilnehmer ohne ID."""
    with db_conn.cursor() as cur:
        cur.execute(
            "insert into member (tenant_id, name, email, role) values (%s, 'Betreiber', 'chef@example.com', 'operator')",
            (tenant_id,),
        )
        cur.execute(
            "insert into member (tenant_id, name, email, role, eegfaktura_participant_id) values (%s, 'Max Alt', 'max@example.com', 'member', 'p-9')",
            (tenant_id,),
        )
    participants = normalize_participants([
        {"id": "p-1", "participantNumber": "001", "firstname": "Chefin", "lastname": "Gruber",
         "contact": {"email": "chef@example.com"}, "meters": [{"meteringPoint": "AT1", "direction": "CONSUMPTION"}]},
        # gleiche E-Mail wie die Zeile von p-9: keine Uebernahme, neue Zeile ohne E-Mail
        {"id": "p-2", "participantNumber": "002", "firstname": "Max", "lastname": "Alt",
         "contact": {"email": "max@example.com"}, "meters": [{"meteringPoint": "AT2", "direction": "CONSUMPTION"}]},
        # ohne ID: Namensabgleich
        {"participantNumber": "003", "firstname": "Ohne", "lastname": "Nummer", "meters": [{"meteringPoint": "AT3", "direction": "CONSUMPTION"}]},
    ])
    load.upsert_members(db_conn, tenant_id, participants)
    load.upsert_members(db_conn, tenant_id, participants)  # idempotent
    with db_conn.cursor() as cur:
        cur.execute(
            "select name, email, role, eegfaktura_participant_id from member where tenant_id = %s order by id",
            (tenant_id,),
        )
        rows = cur.fetchall()
    assert rows[0] == ("Chefin Gruber", "chef@example.com", "operator", "p-1")
    assert rows[1] == ("Max Alt", "max@example.com", "member", "p-9")
    assert rows[2] == ("Max Alt", None, "member", "p-2")
    assert rows[3] == ("Ohne Nummer", None, "member", None)
    assert len(rows) == 4


def test_link_points_loest_veraltete_zuordnung(db_conn, tenant_id):
    participants = normalize_participants([
        {"id": "p-1", "participantNumber": "001", "firstname": "Anna", "lastname": "Gruber",
         "meters": [{"meteringPoint": "AT1", "direction": "CONSUMPTION"}, {"meteringPoint": "AT2", "direction": "GENERATION"}]},
    ])
    load.upsert_members(db_conn, tenant_id, participants)
    load.ensure_measurement_points(db_conn, tenant_id, [("AT1", "consumption", None), ("AT2", "generation", None)])
    load.link_points_to_members(db_conn, tenant_id, participants)
    # AT2 wechselt in EEG-Faktura weg vom Teilnehmer
    participants[0]["points"] = [("AT1", "consumption")]
    load.link_points_to_members(db_conn, tenant_id, participants)
    with db_conn.cursor() as cur:
        cur.execute("select metering_point, member_id is not null from measurement_point where tenant_id = %s order by 1", (tenant_id,))
        assert cur.fetchall() == [("AT1", True), ("AT2", False)]
    # Leere Teilnehmerliste loescht nichts
    load.link_points_to_members(db_conn, tenant_id, [])
    with db_conn.cursor() as cur:
        cur.execute("select count(*) from measurement_point where tenant_id = %s and member_id is not null", (tenant_id,))
        assert cur.fetchone()[0] == 1
