"""Kommandozeile der Pipeline.

    python -m stromkreis_pipeline eegfaktura-probe --tenant <slug>
    python -m stromkreis_pipeline eegfaktura-sync [--tenant <slug>]
        [--since JJJJ-MM-TT] [--until JJJJ-MM-TT] [--full]
    python -m stromkreis_pipeline weather-import [--tenant <slug>]
    python -m stromkreis_pipeline forecast [--tenant <slug>] [--days N]
    python -m stromkreis_pipeline worker

weather-import holt das Open-Meteo-Wetter (Archiv-Erstbefuellung plus
Vorhersage) fuer den Standort jedes Mandanten; forecast rechnet und speichert
einen versionierten Prognoselauf je Mandant (der Worker macht beides auch
selbst: nach jedem Energie-Import und periodisch).

worker arbeitet die von der Plattform beim Betreiber-Login eingestellten
Import-Auftraege ab (eegfaktura_sync_job, Auth per Refresh-Token; Endlosschleife,
Container "worker" im Testdeployment).

probe prueft nur den Zugang (metadata-Endpunkt, keine Schreibzugriffe auf
Energiedaten). sync importiert inkrementell; --full erzwingt den kompletten
Zeitraum ab periodBegin, --since/--until begrenzen das Fenster (Tagesgrenzen
Europe/Vienna).
"""

import argparse
import logging
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import db, forecast, weather
from .eegfaktura import config, sync
from .eegfaktura.client import EegfakturaClient, EegfakturaError

VIENNA = ZoneInfo("Europe/Vienna")
log = logging.getLogger("stromkreis_pipeline")


def _parse_day(value, end_of_day=False):
    day = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=VIENNA)
    return day + timedelta(days=1) if end_of_day else day


def _client_for(source):
    return EegfakturaClient(source.base_url, source.rc_number, config.build_auth(source), ec_id=source.community_id)


def cmd_probe(args):
    with db.connect() as conn:
        sources = config.load_sources(conn, slug=args.tenant)
    failures = 0
    for source in sources:
        try:
            begin, end = _client_for(source).metadata()
            print(f"{source.slug}: Zugang ok, Daten von {begin.date()} bis {end.date()} ({source.auth_mode})")
        except (EegfakturaError, config.ConfigError) as err:
            failures += 1
            print(f"{source.slug}: FEHLER: {err}", file=sys.stderr)
    return 1 if failures else 0


def cmd_sync(args):
    since = _parse_day(args.since) if args.since else None
    until = _parse_day(args.until, end_of_day=True) if args.until else None
    failures = 0
    with db.connect() as conn:
        sources = config.load_sources(conn, slug=args.tenant)
        for source in sources:
            try:
                client = _client_for(source)
                stats = sync.sync_tenant(conn, source, client, since=since, until=until, full=args.full)
                window = ""
                if stats.window_start is not None:
                    window = f", Fenster {stats.window_start.date()} bis {stats.window_end.date()}"
                print(
                    f"{source.slug}: {stats.rows} Zeilen in {stats.chunks} Chunks, "
                    f"{stats.points} Zaehlpunkte{window}"
                )
                for warning in stats.warnings:
                    print(f"{source.slug}: Hinweis: {warning}")
            except (EegfakturaError, config.ConfigError) as err:
                # Fehler je Mandant isolieren, der Gesamtlauf geht weiter
                failures += 1
                conn.rollback()
                log.error("%s: %s", source.slug, err)
                print(f"{source.slug}: FEHLER: {err}", file=sys.stderr)
    return 1 if failures else 0


def cmd_weather(args):
    failures = 0
    with db.connect() as conn:
        for tenant in weather.load_tenants(conn, slug=args.tenant):
            try:
                written = weather.import_weather(conn, tenant)
                print(f"{tenant['slug']}: {written} Wetterstunden geschrieben")
            except Exception as err:  # noqa: BLE001 - Fehler je Mandant isolieren
                failures += 1
                conn.rollback()
                log.exception("%s: Wetterimport fehlgeschlagen", tenant["slug"])
                print(f"{tenant['slug']}: FEHLER: {err}", file=sys.stderr)
    return 1 if failures else 0


def cmd_forecast(args):
    failures = 0
    with db.connect() as conn:
        for tenant in weather.load_tenants(conn, slug=args.tenant):
            try:
                run_id, reason = forecast.run_forecast(conn, tenant, days=args.days)
                if run_id is not None:
                    print(f"{tenant['slug']}: Prognoselauf {run_id} gespeichert")
                else:
                    print(f"{tenant['slug']}: uebersprungen: {reason}")
            except Exception as err:  # noqa: BLE001 - Fehler je Mandant isolieren
                failures += 1
                conn.rollback()
                log.exception("%s: Prognoselauf fehlgeschlagen", tenant["slug"])
                print(f"{tenant['slug']}: FEHLER: {err}", file=sys.stderr)
    return 1 if failures else 0


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="stromkreis_pipeline")
    commands = parser.add_subparsers(dest="command", required=True)

    probe = commands.add_parser("eegfaktura-probe", help="EEG-Faktura-Zugang testen (metadata)")
    probe.add_argument("--tenant", help="Tenant-Slug; ohne Angabe alle aktiven")
    probe.set_defaults(func=cmd_probe)

    run = commands.add_parser("eegfaktura-sync", help="Energiedaten importieren")
    run.add_argument("--tenant", help="Tenant-Slug; ohne Angabe alle aktiven")
    run.add_argument("--since", help="Fensterbeginn JJJJ-MM-TT (Europe/Vienna)")
    run.add_argument("--until", help="Fensterende JJJJ-MM-TT (inklusive)")
    run.add_argument("--full", action="store_true", help="kompletten Zeitraum ab periodBegin importieren")
    run.set_defaults(func=cmd_sync)

    wetter = commands.add_parser("weather-import", help="Open-Meteo-Wetter je Mandant importieren")
    wetter.add_argument("--tenant", help="Tenant-Slug; ohne Angabe alle")
    wetter.set_defaults(func=cmd_weather)

    prognose = commands.add_parser("forecast", help="Prognoselauf je Mandant rechnen und speichern")
    prognose.add_argument("--tenant", help="Tenant-Slug; ohne Angabe alle")
    prognose.add_argument("--days", type=int, help="Horizont in Tagen ab dem letzten vollstaendigen Messtag (Standard: bis heute plus 16)")
    prognose.set_defaults(func=cmd_forecast)

    worker = commands.add_parser("worker", help="Import-Auftraege der Plattform abarbeiten (Endlosschleife)")
    worker.set_defaults(func=lambda args: __import__("stromkreis_pipeline.worker", fromlist=["main_loop"]).main_loop())

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
