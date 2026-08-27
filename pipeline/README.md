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

Modulaufbau (`stromkreis_pipeline/eegfaktura/`): `client.py` (HTTP, beide Auth-Wege, Millisekunden nur an der HTTP-Grenze), `normalize.py` (Slot-zu-kind-Mapping auf das quellenneutrale Zwischenformat, gleiche Kategorien wie der Demo-Generator), `load.py` (COPY-Upsert in `measurement`, Abgleich `meter_code`/`measurement_point`, `daily_reporting_share` als Vertrauens-Gate), `sync.py` (Fensterlogik, mengenabhaengiges Chunking mit Lastschutz-Pausen, Fehler je Mandant isoliert), `config.py` (Quellen + Secrets).

## Wetterimport und Prognose

`weather.py` holt Open-Meteo-Stundenwetter je Mandant fuer den Standort `tenant.latitude/longitude` in die Tabelle `weather`: Erstbefuellung aus dem ERA5-Archiv ab dem ersten Messwert (180-Tage-Stuecke), danach je Lauf der Forecast-Endpunkt (`past_days=92` korrigiert die juengste Vergangenheit, 16 Tage Vorhersage). `forecast.py` ist die Portierung des ISCHLSTROM-Modells gbt-1.1 (`notebooks/forecast/eeg_forecast.py`): drei `HistGradientBoostingRegressor` je Mandant (Verbrauch, Erzeugung, Eigendeckung je aktivem Zaehlpunkt und 15 Minuten, plus q10/q90-Quantilmodelle), rein exogene Merkmale (Kalender samt Feiertagen/Schulferien, Sonnenstand, Wetter), Ueberschuss abgeleitet, Energiebilanz geschlossen, Niveau-Rekalibrierung auf den letzten 14 vollstaendigen Tagen. Laeufe landen versioniert in `forecast_run`/`forecast_value` (nie ueberschrieben); die Prognose beginnt am Tag nach dem letzten vollstaendigen Messtag und fuellt die Luecke bis heute plus 16 Tage. Teillieferungs-Gate: `FORECAST_MIN_REPORTING_SHARE` (0.85), `FORECAST_MIN_POINTS` (5), `FORECAST_MIN_TRAIN_DAYS` (14).

Der Worker macht beides selbst: direkt nach jedem Energie-Import (Ergebnis in `job.progress.forecast`) und periodisch fuer alle Mandanten (`WEATHER_REFRESH_HOURS`, Default 6 h; neuer Prognoselauf, wenn der letzte aelter als `FORECAST_MAX_AGE_HOURS` ist, Default 24 h). Manuell:

```bash
.venv/bin/python -m stromkreis_pipeline weather-import [--tenant <slug>]
.venv/bin/python -m stromkreis_pipeline forecast [--tenant <slug>] [--days N]
```

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


## Worker (Import-Auftraege der Plattform)

`python -m stromkreis_pipeline worker` (Container `worker` im Testdeployment, `pipeline/Dockerfile`) arbeitet die Auftraege in `eegfaktura_sync_job` ab, die die Plattform beim "Anmelden mit EEGFaktura" einstellt. Auth: Refresh-Token des Betreibers aus `eegfaktura_oidc_token` (AES-256-GCM, `TOKEN_SECRET` wie die Plattform), Access-Token per Keycloak-Refresh (`RefreshTokenAuth`), Bearer-Routen (`bearer_routes=True`): `GET /api/participant`, `GET /energystore/eeg/v2/{ecid}/meta`, `POST /energystore/eeg/v2/{ecid}/raw {meters,start,end}`. Phasen: `masterdata` (Teilnehmer -> `member`, Zaehlpunkte -> `measurement_point` mit `member_id`; danach Geokodierung der Mitglieder mit geaenderter Adresse per Nominatim, `geocode.py`: `member.latitude/longitude/geocoded_address`, hoechstens eine Anfrage je Sekunde, strukturiert mit Hausnummer, dann Freitext, dann Strassenebene ohne Hausnummer, Anlagen des Mitglieds mit der alten Mitgliedsadresse bzw. auf dem Gemeinschafts-Mittelpunkt ziehen mit; `NOMINATIM_URL`, `NOMINATIM_USER_AGENT` optional), dann `energy` in mengenabhaengigen Stuecken: Ziel ~500k 15-Minuten-Werte je Anfrage (`chunk_size()` in `sync.py`; bis ~170 Zaehlpunkte 30 Tage, ~700 Zaehlpunkte 7 Tage, Minimum 1 Tag), Pause zwischen den Stuecken max(`WORKER_PACE_SECONDS` (Default 20 s), 2x Antwortzeit der letzten Anfrage), damit der energystore hoechstens etwa ein Drittel der Zeit belegt ist; je Stueck danach `refresh_measurement_daily()` fuer das Tagesaggregat `measurement_daily` (Grundlage des Tabs "Energie"); Fortschritt in `job.progress`. Umgebung: `DATABASE_URL`, `TOKEN_SECRET`, optional `WORKER_POLL_SECONDS`, `WORKER_PACE_SECONDS`.
