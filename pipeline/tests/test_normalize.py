from datetime import datetime, timezone

import pytest

from stromkreis_pipeline.eegfaktura.client import EegfakturaError, from_ms
from stromkreis_pipeline.eegfaktura.normalize import (
    normalize_direction,
    normalize_masterdata,
    normalize_rawdata,
)

TS = 1767225600000  # 2026-01-01T00:00:00Z


def rawdata_payload():
    return {
        "AT_VERBRAUCH": {
            "direction": "CONSUMPTION",
            "data": [
                {"ts": TS, "value": [0.5, 0.3, 0.2], "qov": [1, 1, 2]},
                {"ts": TS + 900_000, "value": [0.4], "qov": [1]},  # G.02/G.03 fehlen noch
            ],
        },
        "AT_ERZEUGUNG": {
            "direction": "GENERATION",
            "data": [
                {"ts": TS, "value": [1.25, 0.75], "qov": [1, 3]},
            ],
        },
    }


def test_slot_mapping_und_qualitaet():
    records = normalize_rawdata(rawdata_payload())
    by_key = {(r.metering_point, r.kind, r.measured_at): r for r in records}
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)

    assert len(records) == 6
    assert by_key[("AT_VERBRAUCH", "total_consumption", start)].value == 0.5
    assert by_key[("AT_VERBRAUCH", "production_share", start)].value == 0.3
    r = by_key[("AT_VERBRAUCH", "self_use", start)]
    assert r.value == 0.2 and r.quality == 2 and r.direction == "consumption"
    assert by_key[("AT_ERZEUGUNG", "total_production", start)].value == 1.25
    r = by_key[("AT_ERZEUGUNG", "overshoot", start)]
    assert r.value == 0.75 and r.quality == 3 and r.direction == "generation"


def test_kuerzere_value_listen_werden_uebersprungen():
    records = normalize_rawdata(rawdata_payload())
    second = datetime(2026, 1, 1, 0, 15, tzinfo=timezone.utc)
    kinds = {r.kind for r in records if r.measured_at == second}
    assert kinds == {"total_consumption"}


def test_unbekannte_richtung_ist_fehler():
    with pytest.raises(EegfakturaError):
        normalize_direction("SIDEWAYS")
    assert normalize_direction("consumption") == "consumption"
    assert normalize_direction("PRODUCER") == "generation"


def test_masterdata_zu_zaehlpunkten():
    payload = [
        {
            "firstName": "Anna", "lastName": "Auer",
            "meteringPoint": [
                {"meteringPoint": "AT1", "direction": "CONSUMPTION"},
                {"meteringPoint": "AT2", "direction": "GENERATION"},
            ],
        },
        {"firstName": None, "lastName": None, "meteringPoint": [{"meteringPoint": "AT3", "direction": "CONSUMPTION"}]},
        {"firstName": "Ohne", "lastName": "Punkte", "meteringPoint": []},
        # Form der echten API: firstname/lastname, meters
        {"firstname": "Max", "lastname": "Mustermann", "meters": [{"meteringPoint": "AT4", "direction": "GENERATION"}]},
    ]
    points = normalize_masterdata(payload)
    assert points == [
        ("AT1", "consumption", "Anna Auer"),
        ("AT2", "generation", "Anna Auer"),
        ("AT3", "consumption", None),
        ("AT4", "generation", "Max Mustermann"),
    ]


def test_doppelte_zeitstempel_letzter_wert_gilt(caplog):
    # energystore v1 liefert am Sommerzeit-Tag 96 Slots; 02:00-02:45 Ortszeit
    # (nicht existent) fallen auf dieselben UTC-Zeitpunkte wie 03:00-03:45.
    ts = 1679792400000  # 2023-03-26 01:00 UTC = 03:00 MESZ
    payload = {"AT1": {"direction": "CONSUMPTION", "data": [
        {"ts": ts, "value": [0.008, 0.0, 0.0], "qov": [1, 1, 1]},
        {"ts": ts + 900000, "value": [0.007, 0.0, 0.0], "qov": [1, 1, 1]},
        {"ts": ts, "value": [0.012, 0.0, 0.0], "qov": [1, 1, 1]},
    ]}}
    records = normalize_rawdata(payload)
    keys = {(r.kind, r.measured_at) for r in records}
    assert len(records) == len(keys) == 6
    total = [r for r in records if r.kind == "total_consumption" and r.measured_at == from_ms(ts)]
    assert total[0].value == 0.012
    assert "doppelte Zeitstempel" in caplog.text
