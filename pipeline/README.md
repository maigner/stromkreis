# pipeline

Python-Datenpipeline von Stromkreis. Läuft als geplanter Job und iteriert über alle Mandanten:

1. **EEG-Faktura-Import** - Energieberichte (API, später auch Export-Dateien) je Mandant laden, unvollständige Lieferungen erkennen (Mindestanteil meldender Zählpunkte)
2. **Wetterimport** - Open-Meteo (Archiv- und Forecast-API) je Mandanten-Standort
3. **Prognoselauf** - 15-Minuten-Prognose der Gemeinschaftserzeugung und -deckung; Läufe werden versioniert gespeichert und nie überschrieben

Portierungsquellen im ISCHLSTROM-Repo: `notebooks/energyData/`, `notebooks/eegfaktura/`, `notebooks/weather/backfill_openmeteo.py`, `notebooks/forecast/eeg_forecast.py`.

## Setup

```bash
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

DB-Zugang über `DATABASE_URL` (Compose-Stack) oder den pg_service-Eintrag `stromkreis` (`.pg_service.conf`, gitignored).

## EEG-Faktura-Import

API-Vertrag und Plan: `docs/eegfaktura-api.md` im Repo-Root. Konfiguration je Mandant in der Tabelle `eegfaktura_source` (RC-Nummer als Tenant, **Gemeinschafts-ID `community_id` als `ecId` der Energiedaten-Endpunkte**, Basis-URL, auth_mode `basic` oder `client_credentials`); Secrets nur in der Umgebung: `EEGFAKTURA_<SLUG>_USER`/`_PASSWORD` bzw. `_CLIENT_ID`/`_CLIENT_SECRET` (Slug großgeschrieben, `-` als `_`). Ohne `community_id` liefert der energystore leere Antworten.

Testgegenstelle: die EEG-Faktura-Testinstanz auf `server` (`deploy/eegfaktura-local/README.md`, Befunde in `docs/eegfaktura-lokal.md`), Basis-URL `https://eegfaktura-test.stromkreis.net`, Benutzer `importer`.

```bash
# Zugang testen (metadata-Endpunkt, schreibt keine Energiedaten)
.venv/bin/python -m stromkreis_pipeline eegfaktura-probe --tenant ischlstrom

# Import: inkrementell ab letztem Wert minus 14 Tage Überlappung, Monats-Chunks
.venv/bin/python -m stromkreis_pipeline eegfaktura-sync [--tenant <slug>]

# Erstimport ab periodBegin bzw. begrenztes Fenster (Tagesgrenzen Europe/Vienna)
.venv/bin/python -m stromkreis_pipeline eegfaktura-sync --tenant ischlstrom --full
.venv/bin/python -m stromkreis_pipeline eegfaktura-sync --since 2026-01-01 --until 2026-01-31
```

Modulaufbau (`stromkreis_pipeline/eegfaktura/`): `client.py` (HTTP, beide Auth-Wege, Millisekunden nur an der HTTP-Grenze), `normalize.py` (Slot-zu-kind-Mapping auf das quellenneutrale Zwischenformat, gleiche Kategorien wie der Demo-Generator), `load.py` (COPY-Upsert in `measurement`, Abgleich `meter_code`/`measurement_point`, `daily_reporting_share` als Vertrauens-Gate), `sync.py` (Fensterlogik, Chunking, Fehler je Mandant isoliert), `config.py` (Quellen + Secrets).

## Tests

```bash
.venv/bin/python -m pytest tests
```

Die DB-Tests laufen nur mit `STROMKREIS_TEST_DATABASE_URL` gegen eine Wegwerf-DB mit angewendeten Plattform-Migrationen, z.B.:

```bash
docker run -d --rm --name pg-test -e POSTGRES_PASSWORD=postgres -p 54331:5432 postgres:17-alpine
(cd ../platform && DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54331/stromkreis_dev?sslmode=disable" npx dbmate up)
STROMKREIS_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54331/stromkreis_dev?sslmode=disable" .venv/bin/python -m pytest tests
docker stop pg-test
```
