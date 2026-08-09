import base64
from datetime import datetime, timezone

import pytest

from stromkreis_pipeline.eegfaktura.client import (
    BasicAuth,
    ClientCredentialsAuth,
    EegfakturaClient,
    EegfakturaError,
    from_ms,
    to_ms,
)

START = datetime(2026, 1, 1, tzinfo=timezone.utc)
END = datetime(2026, 1, 2, tzinfo=timezone.utc)


def test_to_ms_ist_millisekunden():
    # Die Notebook-Probe von 12/2025 scheiterte an Sekunden statt Millisekunden
    assert to_ms(START) == 1767225600000
    assert from_ms(1767225600000) == START


def test_to_ms_verweigert_naive_datetimes():
    with pytest.raises(ValueError):
        to_ms(datetime(2026, 1, 1))


def test_basic_auth_nutzt_urlsafe_base64():
    # Der Server dekodiert URL-safe; '+' und '/' im Standard-Base64 wuerden scheitern.
    # "user:>>>???" enthaelt im Standard-Base64 beide Zeichen.
    auth = BasicAuth("user", ">>>???")
    header = auth.headers()["Authorization"]
    assert header.startswith("Basic ")
    encoded = header[len("Basic "):]
    assert base64.standard_b64encode(b"user:>>>???").decode() != encoded
    assert "+" not in encoded and "/" not in encoded
    assert base64.urlsafe_b64decode(encoded) == b"user:>>>???"


def test_rawdata_schickt_millisekunden_und_tenant_header(fake_api):
    fake_api.responses[("POST", "/energystore/query/rawdata")] = (200, {})
    client = EegfakturaClient(fake_api.url, "rc101533", BasicAuth("u", "p"))
    client.rawdata(START, END, metering_points=["AT003000001"])

    method, path, headers, body = fake_api.requests[0]
    assert headers["X-Tenant"] == "RC101533"  # Server vergleicht grossgeschrieben
    assert body["ecId"] == "RC101533"
    assert body["start"] == 1767225600000
    assert body["end"] == 1767312000000
    assert body["cps"] == [{"meteringPoint": "AT003000001"}]


def test_rawdata_ohne_cps_laesst_feld_weg(fake_api):
    fake_api.responses[("POST", "/energystore/query/rawdata")] = (200, {})
    client = EegfakturaClient(fake_api.url, "RC1", BasicAuth("u", "p"))
    client.rawdata(START, END)
    _, _, _, body = fake_api.requests[0]
    assert "cps" not in body


def test_metadata_flach_und_je_zaehlpunkt(fake_api):
    client = EegfakturaClient(fake_api.url, "RC1", BasicAuth("u", "p"))
    path = ("POST", "/energystore/query/RC1/metadata")

    fake_api.responses[path] = (200, {"periodBegin": 1767225600000, "periodEnd": 1767312000000})
    assert client.metadata() == (START, END)

    fake_api.responses[path] = (200, {
        "AT1": {"periodBegin": 1767225600000, "periodEnd": 1767225600000},
        "AT2": {"periodBegin": 1767139200000, "periodEnd": 1767312000000},
    })
    begin, end = client.metadata()
    assert begin == from_ms(1767139200000)
    assert end == END


def test_fehlerantwort_wird_zur_exception(fake_api):
    fake_api.responses[("POST", "/energystore/query/rawdata")] = (400, {"error": "bad"})
    client = EegfakturaClient(fake_api.url, "RC1", BasicAuth("u", "p"))
    with pytest.raises(EegfakturaError) as excinfo:
        client.rawdata(START, END)
    assert excinfo.value.status == 400


def test_client_credentials_cached_token_und_retry_bei_401(fake_api):
    fake_api.responses[("POST", "/token")] = (200, {"access_token": "tok1", "expires_in": 300})
    fake_api.responses[("GET", "/api/master/masterdata")] = (200, [])

    auth = ClientCredentialsAuth(fake_api.url + "/token", "client-id", "geheim")
    client = EegfakturaClient(fake_api.url, "RC1", auth)

    client.masterdata()
    client.masterdata()

    token_requests = [r for r in fake_api.requests if r[1] == "/token"]
    assert len(token_requests) == 1  # zweiter Aufruf nutzt den Cache
    # Client-ID im Authorization-Header, nicht im Body
    basic = token_requests[0][2]["Authorization"]
    assert basic.startswith("Basic ")
    assert base64.b64decode(basic[len("Basic "):]) == b"client-id:geheim"

    # 401 fuehrt zu Token-Erneuerung und einem zweiten Versuch
    fake_api.responses[("GET", "/api/master/masterdata")] = (401, {})
    fake_api.responses[("POST", "/token")] = (200, {"access_token": "tok2", "expires_in": 300})
    with pytest.raises(EegfakturaError):
        client.masterdata()
    token_requests = [r for r in fake_api.requests if r[1] == "/token"]
    assert len(token_requests) == 2
