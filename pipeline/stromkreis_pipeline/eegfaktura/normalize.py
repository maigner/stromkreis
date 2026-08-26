"""Normalisierung der EEG-Faktura-Daten auf ein Quellen-neutrales Zwischenformat.

Das Zwischenformat (Record) ist der gemeinsame Nenner fuer API-Rohdaten und
(spaeter) den Excel-Export: eine Zeile je Zaehlpunkt, Kategorie und
15-Minuten-Intervall. Der Ladepfad (load.py) kennt nur dieses Format.

Slot-Belegung der rawdata-Antwort (fix, siehe docs/eegfaktura-api.md):
Verbraucher value[0..2] = G.01, G.02, G.03; Erzeuger value[0..1] = G.01, P.01.
"""

import logging
from dataclasses import dataclass
from datetime import datetime

from .client import EegfakturaError, from_ms

log = logging.getLogger(__name__)

# Kategorien je Richtung in Slot-Reihenfolge der API
KINDS_CONSUMPTION = ("total_consumption", "production_share", "self_use")
KINDS_GENERATION = ("total_production", "overshoot")

# Beschreibungen wie im EEG-Faktura-Export (identisch zum Demo-Generator
# platform/scripts/demo-data.js, damit API- und Excel-Import in denselben
# meter_code-Zeilen landen)
METER_CODES = {
    "total_consumption": "Gesamtverbrauch lt. Messung (bei Teilnahme gem. Erzeugung)",
    "production_share": "Anteil gemeinschaftliche Erzeugung",
    "self_use": "Eigendeckung gemeinschaftliche Erzeugung",
    "total_production": "Gesamte gemeinschaftliche Erzeugung",
    "overshoot": "Gesamt/Überschusserzeugung, Gemeinschaftsüberschuss",
}
METER_CODE_UNIT = "kWh"


@dataclass(frozen=True)
class Record:
    metering_point: str
    direction: str  # 'consumption' | 'generation' (DB-Werte)
    kind: str
    measured_at: datetime  # Intervallbeginn, UTC
    value: float  # kWh im Intervall
    quality: int | None  # qov: 1 gemessen, 2 Ersatzwert, 3 geschaetzt, 0 unbekannt


def normalize_direction(raw):
    """API-Richtung ('CONSUMPTION', 'GENERATION', auch v1-interne Varianten)
    auf die DB-Werte 'consumption'/'generation' abbilden."""
    d = str(raw).strip().upper()
    if d.startswith("CON"):
        return "consumption"
    if d.startswith(("GEN", "PRO")):
        return "generation"
    raise EegfakturaError(f"Unbekannte Richtung: {raw!r}")


def normalize_rawdata(payload):
    """rawdata-Antwort (Map Zaehlpunkt zu {direction, data}) zu Records.

    Werte fehlender Slots werden uebersprungen (kuerzere value-Listen kommen
    vor, wenn der Netzbetreiber einzelne Kategorien noch nicht liefert).

    Doppelte Zeitstempel je Zaehlpunkt und Kategorie: der energystore (v1)
    liefert am Tag der Sommerzeitumstellung 96 statt 92 Slots, die vier
    nicht existierenden Ortszeit-Slots 02:00 bis 02:45 fallen auf dieselben
    UTC-Zeitpunkte wie 03:00 bis 03:45 (Befund Testinstanz 24.8.2026). Der
    spaeter gelieferte Wert ist der der echten Ortszeit und gilt; ohne diese
    Bereinigung scheitert der Upsert (ON CONFLICT trifft eine Zeile zweimal).
    """
    records = _dedupe(_records(payload))
    return records


def _dedupe(records):
    by_key = {}
    for r in records:
        by_key[(r.metering_point, r.kind, r.measured_at)] = r  # letzter Wert gilt
    dropped = len(records) - len(by_key)
    if dropped:
        log.warning("%d doppelte Zeitstempel verworfen (Sommerzeitumstellung?), letzter Wert gilt", dropped)
    return list(by_key.values())


def _records(payload):
    records = []
    for metering_point, block in payload.items():
        if not isinstance(block, dict) or "data" not in block:
            raise EegfakturaError(f"rawdata: unerwarteter Block fuer {metering_point}")
        direction = normalize_direction(block.get("direction"))
        kinds = KINDS_CONSUMPTION if direction == "consumption" else KINDS_GENERATION
        for row in block["data"] or []:
            measured_at = from_ms(row["ts"])
            values = row.get("value") or []
            qov = row.get("qov") or []
            for slot, kind in enumerate(kinds):
                if slot >= len(values) or values[slot] is None:
                    continue
                quality = qov[slot] if slot < len(qov) else None
                records.append(Record(
                    metering_point=metering_point,
                    direction=direction,
                    kind=kind,
                    measured_at=measured_at,
                    value=float(values[slot]),
                    quality=quality,
                ))
    return records


def normalize_masterdata(payload):
    """masterdata-Antwort zu (metering_point, direction, label)-Tupeln.

    label ist der Teilnehmername (Vor- und Nachname); Geraetename waere
    verfuegbar, der Teilnehmerbezug ist fuers Dashboard aber nuetzlicher.
    """
    # Feldnamen der echten API (/api/master/masterdata, Befund Testinstanz
    # 24.8.2026): firstname/lastname und meters; die camelCase-Variante bleibt
    # als Fallback (Form des Web-Endpunkts /participant).
    points = []
    for participant in payload:
        first = participant.get("firstname") or participant.get("firstName")
        last = participant.get("lastname") or participant.get("lastName")
        name = " ".join(part for part in (first, last) if part).strip() or None
        meters = participant.get("meters")
        if meters is None:
            meters = participant.get("meteringPoint") or []
        for meter in meters:
            mp = meter.get("meteringPoint")
            if not mp:
                continue
            points.append((mp, normalize_direction(meter.get("direction")), name))
    return points


def normalize_participants(payload):
    """participant-Antwort (Bearer-Route /api/participant) zu Teilnehmern.

    Rueckgabe: Liste von dicts {external_id, participant_number, name, email,
    address, points: [(metering_point, direction)]}. Beide Namensformen
    (firstname/firstName) werden akzeptiert; Zaehlpunkte ohne Nummer fallen weg.
    """
    result = []
    for p in payload:
        first = p.get("firstname") or p.get("firstName") or ""
        last = p.get("lastname") or p.get("lastName") or ""
        name = " ".join(part for part in (first, last) if part).strip() or f"Teilnehmer {p.get('participantNumber') or p.get('id')}"
        contact = p.get("contact") or {}
        addr = p.get("residentAddress") or p.get("billingAddress") or {}
        street = " ".join(part for part in (addr.get("street"), addr.get("streetNumber")) if part)
        city = " ".join(part for part in (addr.get("zip"), addr.get("city")) if part)
        address = ", ".join(part for part in (street, city) if part) or None
        points = []
        for meter in p.get("meters") or p.get("meteringPoint") or []:
            mp = meter.get("meteringPoint")
            if not mp:
                continue
            points.append((mp, normalize_direction(meter.get("direction") or "CONSUMPTION")))
        result.append({
            "external_id": str(p.get("id")) if p.get("id") is not None else None,
            "participant_number": str(p.get("participantNumber")) if p.get("participantNumber") else None,
            "name": name,
            "email": (contact.get("email") or None),
            "address": address,
            "points": points,
        })
    return result
