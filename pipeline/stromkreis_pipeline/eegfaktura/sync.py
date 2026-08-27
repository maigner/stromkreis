"""Sync-Strategie: inkrementeller Import je Mandant in Chunks.

Erstimport ab periodBegin aus metadata, danach ab letztem importierten
Intervall minus Ueberlappungsfenster (Ersatzwerte werden von EEG-Faktura
nachtraeglich korrigiert). Der energystore liest serverseitig die ganze
angefragte Range in den Speicher, deshalb begrenzte Chunks und keine
parallelen Anfragen je Mandant.

Chunk-Groesse ist mengenabhaengig: Ziel sind etwa CHUNK_TARGET_VALUES
15-Minuten-Werte je Anfrage. Kleine EEGs bekommen weiterhin 30-Tage-Stuecke,
grosse (z.B. 500 Mitglieder, ~700 Zaehlpunkte) automatisch kuerzere, damit
Antwortgroesse und Last je Anfrage etwa gleich bleiben. Zwischen den Chunks
pausiert der Import mindestens pace_seconds, bei langsamen Antworten laenger
(PACE_DUTY_FACTOR-fache Antwortzeit), damit die EEG-Faktura-DB nie mehr als
etwa ein Drittel der Zeit mit uns beschaeftigt ist.
"""

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from . import load
from .client import EegfakturaError
from .normalize import normalize_masterdata, normalize_rawdata

log = logging.getLogger(__name__)

OVERLAP = timedelta(days=14)
CHUNK_TARGET_VALUES = 500_000  # angepeilte 15-Minuten-Werte je Anfrage
CHUNK_MAX = timedelta(days=30)
CHUNK_MIN = timedelta(days=1)
PACE_DUTY_FACTOR = 2.0  # Pause >= doppelte Antwortzeit der letzten Anfrage
SLOTS_PER_DAY = 96


def chunk_size(point_count):
    """Chunk-Laenge, sodass eine Anfrage etwa CHUNK_TARGET_VALUES Werte liefert.

    43 Zaehlpunkte -> 30 Tage (Kappe), 700 Zaehlpunkte -> 7 Tage, ab ~5200 -> 1 Tag.
    """
    if not point_count or point_count <= 0:
        return CHUNK_MAX
    days = CHUNK_TARGET_VALUES // (point_count * SLOTS_PER_DAY)
    return max(CHUNK_MIN, min(CHUNK_MAX, timedelta(days=int(days) or 1)))


@dataclass
class SyncStats:
    tenant_slug: str
    window_start: datetime | None = None
    window_end: datetime | None = None
    chunks: int = 0
    rows: int = 0
    points: int = 0
    warnings: list = field(default_factory=list)
    point_ids: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SourceInfo:
    """Minimale Quellbeschreibung fuer sync_tenant (der Worker hat keine TenantSource)."""
    tenant_id: int
    slug: str


def last_measured_at(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute("select max(measured_at) from measurement where tenant_id = %s", (tenant_id,))
        return cur.fetchone()[0]


def determine_window(conn, tenant_id, client, since=None, until=None, full=False):
    """Importfenster [start, end] bestimmen. Rueckgabe (start, end) in UTC."""
    end = until or datetime.now(tz=timezone.utc)
    if since is not None:
        return since, end
    if not full:
        last = last_measured_at(conn, tenant_id)
        if last is not None:
            return last - OVERLAP, end
    period_begin, period_end = client.metadata()
    return period_begin, min(end, period_end) if until is None else end


def sync_tenant(conn, source, client, since=None, until=None, full=False, on_chunk=None, use_masterdata=True,
                pace_seconds=5.0):
    """Einen Mandanten importieren. Commit je Chunk; wirft EegfakturaError
    bei Zugangs-/API-Fehlern (der Aufrufer isoliert je Mandant).

    on_chunk(stats, chunk_start, chunk_end) wird nach jedem Chunk gerufen
    (Fortschrittsanzeige). use_masterdata=False ueberspringt /api/master/masterdata
    (Bearer-Weg: die Zaehlpunkte kommen aus measurement_point bzw. metadata).
    pace_seconds: Mindestpause zwischen zwei Chunks (die tatsaechliche Pause ist
    max(pace_seconds, PACE_DUTY_FACTOR * Antwortzeit), nach dem letzten Chunk keine)."""
    stats = SyncStats(tenant_slug=source.slug)
    tenant_id = source.tenant_id

    code_ids = load.ensure_meter_codes(conn, tenant_id)

    # Stammdaten sind optional: liefert /api/master/masterdata nichts (z.B.
    # nicht extern erreichbar), kommen die Zaehlpunkte aus den Rohdaten.
    known_points = None
    if use_masterdata:
        try:
            master_points = normalize_masterdata(client.masterdata())
            point_ids = load.ensure_measurement_points(conn, tenant_id, master_points)
            known_points = [mp for mp, _, _ in master_points]
            conn.commit()
        except EegfakturaError as err:
            msg = f"masterdata nicht verfuegbar, Zaehlpunkte kommen aus den Rohdaten ({err})"
            log.warning("%s: %s", source.slug, msg)
            stats.warnings.append(msg)
            point_ids = load.ensure_measurement_points(conn, tenant_id, [])
    else:
        point_ids = load.ensure_measurement_points(conn, tenant_id, [])
        # Bekannte Zaehlpunkte plus alle, fuer die der energystore Daten hat
        known_points = sorted(set(point_ids) | set(client.metadata_points()))
    stats.point_ids = point_ids

    start, end = determine_window(conn, tenant_id, client, since=since, until=until, full=full)
    stats.window_start, stats.window_end = start, end
    if start >= end:
        log.info("%s: nichts zu tun (Fenster leer)", source.slug)
        return stats

    chunk_start = start
    while chunk_start < end:
        # Chunk-Laenge je Durchlauf neu: aus den Rohdaten koennen Zaehlpunkte dazukommen
        chunk = chunk_size(len(known_points) if known_points else len(point_ids))
        chunk_end = min(chunk_start + chunk, end)
        request_started = time.monotonic()
        payload = client.rawdata(chunk_start, chunk_end, metering_points=known_points)
        request_seconds = time.monotonic() - request_started
        records = normalize_rawdata(payload)

        # Zaehlpunkte, die nur in den Rohdaten auftauchen, nachziehen
        missing = {r.metering_point for r in records} - set(point_ids)
        if missing:
            seen = {}
            for r in records:
                if r.metering_point in missing and r.metering_point not in seen:
                    seen[r.metering_point] = (r.metering_point, r.direction, None)
            point_ids = load.ensure_measurement_points(conn, tenant_id, seen.values())

        stats.rows += load.upsert_measurements(conn, tenant_id, records, point_ids, code_ids)
        # Tagesaggregat (measurement_daily) fuer den Chunk nachziehen, Grundlage des Tabs "Energie"
        load.refresh_daily(conn, tenant_id, chunk_start, chunk_end)
        stats.chunks += 1
        stats.point_ids = point_ids
        conn.commit()
        log.info(
            "%s: Chunk %s bis %s (%d Tage, %.1f s), %d Zeilen bisher",
            source.slug, chunk_start.date(), chunk_end.date(), chunk.days, request_seconds, stats.rows,
        )
        if on_chunk is not None:
            on_chunk(stats, chunk_start, chunk_end)
        chunk_start = chunk_end
        if chunk_start < end:
            time.sleep(max(pace_seconds, PACE_DUTY_FACTOR * request_seconds))

    stats.points = len(point_ids)
    return stats
