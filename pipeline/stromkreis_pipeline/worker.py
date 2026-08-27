"""Hintergrund-Worker: arbeitet eegfaktura_sync_job-Auftraege ab, die die
Plattform beim Betreiber-Login einstellt.

Ablauf je Auftrag (bewusst langsam, damit die EEG-Faktura-Instanz nicht unter
Last geraet und die Plattform waehrend des Imports fluessig bleibt):
  1. Phase masterdata: Teilnehmer und Zaehlpunkte (GET /api/participant) in
     member und measurement_point uebernehmen; Mitglieder mit geaenderter
     Adresse geokodieren (geocode.py, Nominatim) und ihre Anlagen nachziehen.
  2. Phase energy: Energiedaten in 30-Tage-Stuecken, mit Pause zwischen den
     Stuecken (PACE_SECONDS), Fortschritt je Stueck in job.progress.
Auth: Refresh-Token des Betreibers (eegfaktura_oidc_token, verschluesselt),
Access-Token per Keycloak-Refresh; Fehler landen in job.error bzw.
eegfaktura_oidc_token.last_error (dann hilft ein erneuter Login).

Es laeuft genau ein Auftrag gleichzeitig (ein Worker-Prozess); ein Auftrag,
dessen heartbeat aelter als STALE_MINUTES ist, gilt als verwaist und wird
neu aufgenommen.
"""

import json
import logging
import os
import time
from datetime import datetime, timezone

from . import db, forecast, geocode, secrets, weather
from .eegfaktura import load, sync
from .eegfaktura.client import EegfakturaClient, EegfakturaError, RefreshTokenAuth
from .eegfaktura.normalize import normalize_participants

log = logging.getLogger(__name__)

POLL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "15"))
PACE_SECONDS = float(os.environ.get("WORKER_PACE_SECONDS", "20"))
STALE_MINUTES = 30
# Wetter je Mandant regelmaessig nachziehen (Open-Meteo-Prognose aendert sich
# laufend) und Prognosen neu rechnen, wenn der letzte Lauf zu alt ist
WEATHER_REFRESH_HOURS = float(os.environ.get("WEATHER_REFRESH_HOURS", "6"))
FORECAST_MAX_AGE_HOURS = float(os.environ.get("FORECAST_MAX_AGE_HOURS", "24"))
ACTIVE = ("queued", "masterdata", "energy")


def _json(value):
    return json.dumps(value, default=lambda v: v.isoformat() if isinstance(v, datetime) else str(v))


def claim_job(conn):
    """Naechsten offenen Auftrag uebernehmen (aelteste Anforderung zuerst)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update eegfaktura_sync_job j
            set started_at = coalesce(started_at, now()), heartbeat_at = now(),
                phase = case when phase = 'queued' then 'masterdata' else phase end
            where j.id = (
                select id from eegfaktura_sync_job
                where phase = 'queued'
                   or (phase in ('masterdata', 'energy') and heartbeat_at < now() - make_interval(mins => %s))
                order by requested_at
                limit 1
                for update skip locked
            )
            returning j.id, j.tenant_id, j.phase, j.full_import, j.progress
            """,
            (STALE_MINUTES,),
        )
        row = cur.fetchone()
    conn.commit()
    if row is None:
        return None
    return {"id": row[0], "tenant_id": row[1], "phase": row[2], "full_import": row[3], "progress": row[4] or {}}


def update_job(conn, job_id, phase=None, progress=None, error=None, finished=False):
    with conn.cursor() as cur:
        cur.execute(
            """
            update eegfaktura_sync_job
            set phase = coalesce(%s, phase),
                progress = case when %s::jsonb is null then progress else progress || %s::jsonb end,
                error = %s,
                heartbeat_at = now(),
                finished_at = case when %s then now() else finished_at end
            where id = %s
            """,
            (phase, _json(progress) if progress is not None else None, _json(progress) if progress is not None else None,
             error, finished, job_id),
        )
    conn.commit()


def load_source(conn, tenant_id):
    with conn.cursor() as cur:
        cur.execute(
            """
            select s.tenant_id, t.slug, s.rc_number, s.community_id, s.base_url, s.auth_mode, s.token_url,
                   o.client_id, o.refresh_token_enc, o.issuer
            from eegfaktura_source s
            join tenant t on t.id = s.tenant_id
            left join eegfaktura_oidc_token o on o.tenant_id = s.tenant_id
            where s.tenant_id = %s
            """,
            (tenant_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise EegfakturaError("keine eegfaktura_source fuer den Mandanten")
    return {
        "tenant_id": row[0], "slug": row[1], "rc_number": row[2], "community_id": row[3], "base_url": row[4],
        "auth_mode": row[5], "token_url": row[6], "client_id": row[7], "refresh_token_enc": row[8], "issuer": row[9],
    }


def build_client(conn, src):
    if src["auth_mode"] != "oidc":
        raise EegfakturaError(f"auth_mode {src['auth_mode']} wird vom Worker nicht unterstuetzt (nur oidc)")
    if not src["refresh_token_enc"]:
        raise EegfakturaError("kein Refresh-Token gespeichert; bitte erneut mit EEGFaktura anmelden")
    token_url = src["token_url"] or f"{src['issuer']}/protocol/openid-connect/token"

    def store(new_refresh_token, error=None):
        with conn.cursor() as cur:
            if new_refresh_token:
                cur.execute(
                    "update eegfaktura_oidc_token set refresh_token_enc = %s, refreshed_at = now(), last_error = null where tenant_id = %s",
                    (secrets.encrypt(new_refresh_token), src["tenant_id"]),
                )
            else:
                cur.execute(
                    "update eegfaktura_oidc_token set last_error = %s where tenant_id = %s",
                    (error, src["tenant_id"]),
                )
        conn.commit()

    auth = RefreshTokenAuth(token_url, src["client_id"], secrets.decrypt(src["refresh_token_enc"]), on_refresh=store)
    return EegfakturaClient(src["base_url"], src["rc_number"], auth, ec_id=src["community_id"], bearer_routes=True)


def run_job(conn, job):
    src = load_source(conn, job["tenant_id"])
    client = build_client(conn, src)
    tenant_id = job["tenant_id"]
    log.info("%s: Auftrag %s, Phase %s", src["slug"], job["id"], job["phase"])

    if job["phase"] == "masterdata":
        participants = normalize_participants(client.participants())
        counts = load.upsert_members(conn, tenant_id, participants)
        points = [(mp, direction, name) for p in participants for (mp, direction) in p["points"] for name in [p["name"]]]
        point_ids = load.ensure_measurement_points(conn, tenant_id, points)
        load.link_points_to_members(conn, tenant_id, participants)
        conn.commit()
        geocoded, missed = geocode.geocode_members(conn, tenant_id)
        conn.commit()
        if geocoded or missed:
            log.info("%s: %d Mitglieder geokodiert, %d ohne Treffer", src["slug"], geocoded, missed)
        update_job(conn, job["id"], phase="energy", progress={
            "members": counts, "points": len(point_ids), "geocoded": geocoded, "geocode_missed": missed})
        job["phase"] = "energy"
        time.sleep(min(PACE_SECONDS, 5))

    if job["phase"] == "energy":
        def on_chunk(stats, chunk_start, chunk_end):
            update_job(conn, job["id"], progress={
                "rows": stats.rows, "chunks": stats.chunks, "points": stats.points or len(stats.point_ids),
                "chunk_start": chunk_start, "chunk_end": chunk_end,
                "period_begin": stats.window_start, "period_end": stats.window_end,
            })

        # Pausen macht sync_tenant selbst: mindestens PACE_SECONDS je Chunk,
        # bei langsamen energystore-Antworten laenger (Lastschutz)
        source = sync.SourceInfo(tenant_id=tenant_id, slug=src["slug"])
        stats = sync.sync_tenant(conn, source, client, full=job["full_import"], on_chunk=on_chunk,
                                 use_masterdata=False, pace_seconds=PACE_SECONDS)
        # Direkt nach dem Import: Wetter fuer den EEG-Standort aktualisieren
        # und einen neuen Prognoselauf rechnen. Fehler dabei lassen den
        # Import-Auftrag nicht scheitern, sie landen als Hinweis in progress.
        forecast_note = refresh_forecast(conn, tenant_id, src["slug"])
        update_job(conn, job["id"], phase="done", finished=True, progress={
            "rows": stats.rows, "chunks": stats.chunks, "points": stats.points,
            "period_begin": stats.window_start, "period_end": stats.window_end, "chunk_end": stats.window_end,
            "warnings": stats.warnings, "forecast": forecast_note,
        })
        log.info("%s: Auftrag %s fertig, %d Zeilen in %d Stuecken", src["slug"], job["id"], stats.rows, stats.chunks)


def refresh_forecast(conn, tenant_id, slug):
    """Wetterimport und Prognoselauf fuer einen Mandanten; Fehler werden nur
    gemeldet (Rueckgabe fuer job.progress), nie geworfen."""
    note = {}
    tenants = weather.load_tenants(conn, tenant_id=tenant_id)
    if not tenants:
        return {"error": "Mandant nicht gefunden"}
    tenant = tenants[0]
    try:
        note["weather_hours"] = weather.import_weather(conn, tenant)
    except Exception as err:  # noqa: BLE001
        conn.rollback()
        log.exception("%s: Wetterimport fehlgeschlagen", slug)
        note["weather_error"] = str(err)[:300]
    try:
        run_id, reason = forecast.run_forecast(conn, tenant)
        if run_id is not None:
            note["run_id"] = run_id
        else:
            note["skipped"] = reason
            log.info("%s: Prognoselauf uebersprungen: %s", slug, reason)
    except Exception as err:  # noqa: BLE001
        conn.rollback()
        log.exception("%s: Prognoselauf fehlgeschlagen", slug)
        note["error"] = str(err)[:300]
    return note


def maintenance(conn):
    """Alle Mandanten: Wetter aktuell halten und veraltete Prognosen neu
    rechnen (Schleife ueber Mandanten, laeuft nur bei leerer Auftragsschlange)."""
    for tenant in weather.load_tenants(conn):
        try:
            weather.import_weather(conn, tenant)
        except Exception:  # noqa: BLE001
            conn.rollback()
            log.exception("%s: Wetterimport fehlgeschlagen", tenant["slug"])
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "select max(created_at) < now() - make_interval(secs => %s) "
                    "from forecast_run where tenant_id = %s",
                    (FORECAST_MAX_AGE_HOURS * 3600.0, tenant["id"]),
                )
                stale = cur.fetchone()[0]
            if stale is None or stale:
                run_id, reason = forecast.run_forecast(conn, tenant)
                if run_id is not None:
                    log.info("%s: Prognose aufgefrischt (Lauf %s)", tenant["slug"], run_id)
                elif stale is None:
                    log.info("%s: Prognoselauf uebersprungen: %s", tenant["slug"], reason)
        except Exception:  # noqa: BLE001
            conn.rollback()
            log.exception("%s: Prognoselauf fehlgeschlagen", tenant["slug"])


def run_once(conn):
    job = claim_job(conn)
    if job is None:
        return False
    try:
        run_job(conn, job)
    except Exception as err:  # noqa: BLE001 - jeder Fehler landet am Auftrag, der Worker lebt weiter
        conn.rollback()
        log.exception("Auftrag %s fehlgeschlagen", job["id"])
        update_job(conn, job["id"], phase="error", error=str(err)[:1000], finished=True)
    return True


def main_loop():
    log.info("Worker gestartet (Poll %ss, Pause je Stueck %ss)", POLL_SECONDS, PACE_SECONDS)
    last_maintenance = None
    while True:
        try:
            with db.connect() as conn:
                while run_once(conn):
                    pass
                if last_maintenance is None or time.monotonic() - last_maintenance >= WEATHER_REFRESH_HOURS * 3600:
                    maintenance(conn)
                    last_maintenance = time.monotonic()
        except Exception:  # noqa: BLE001 - z.B. DB nicht erreichbar: warten und neu verbinden
            log.exception("Worker-Schleife: Fehler, neuer Versuch in %ss", POLL_SECONDS)
        time.sleep(POLL_SECONDS)
