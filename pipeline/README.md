# pipeline

Python-Datenpipeline von Stromkreis. Läuft als geplanter Job und iteriert über alle Mandanten:

1. **EEG-Faktura-Import** - Energieberichte (Export-Dateien und API) je Mandant laden, unvollständige Lieferungen erkennen (Mindestanteil meldender Zählpunkte)
2. **Wetterimport** - Open-Meteo (Archiv- und Forecast-API) je Mandanten-Standort
3. **Prognoselauf** - 15-Minuten-Prognose der Gemeinschaftserzeugung und -deckung; Läufe werden versioniert gespeichert und nie überschrieben

Portierungsquellen im ISCHLSTROM-Repo: `notebooks/energyData/`, `notebooks/eegfaktura/`, `notebooks/weather/backfill_openmeteo.py`, `notebooks/forecast/eeg_forecast.py`.

## Setup

```bash
python -m venv .venv
.venv/bin/pip install -e .
```

DB-Zugang über `.pg_service.conf` (gitignored), Service-Name `stromkreis`.
