"""Sync-Strategie: inkrementeller Import je Mandant in Monats-Chunks.

Erstimport ab periodBegin aus metadata, danach ab letztem importierten
Intervall minus Ueberlappungsfenster (Ersatzwerte werden von EEG-Faktura
nachtraeglich korrigiert). v1 der Energystore liest serverseitig die ganze
angefragte Range in den Speicher, deshalb kleine Chunks und keine parallelen
Anfragen je Mandant.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from . import load
from .client import EegfakturaError
from .normalize import normalize_masterdata, normalize_rawdata

log = logging.getLogger(__name__)

OVERLAP = timedelta(days=14)
CHUNK = timedelta(days=30)


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


def sync_tenant(conn, source, client, since=None, until=None, full=False, on_chunk=None, use_masterdata=True):
    """Einen Mandanten importieren. Commit je Chunk; wirft EegfakturaError
    bei Zugangs-/API-Fehlern (der Aufrufer isoliert je Mandant).

    on_chunk(stats, chunk_start, chunk_end) wird nach jedem Chunk gerufen
    (Fortschritt, Pausen). use_masterdata=False ueberspringt /api/master/masterdata
    (Bearer-Weg: die Zaehlpunkte kommen aus measurement_point bzw. metadata)."""
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
        chunk_end = min(chunk_start + CHUNK, end)
        payload = client.rawdata(chunk_start, chunk_end, metering_points=known_points)
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
            "%s: Chunk %s bis %s, %d Zeilen bisher",
            source.slug, chunk_start.date(), chunk_end.date(), stats.rows,
        )
        if on_chunk is not None:
            on_chunk(stats, chunk_start, chunk_end)
        chunk_start = chunk_end

    stats.points = len(point_ids)
    return stats
