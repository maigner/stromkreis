# Architektur

## Grundentscheidung: eine mandantenfähige Instanz

Stromkreis läuft als **eine** gehostete Instanz für alle teilnehmenden EEGs (Mandanten), nicht als Instanz je EEG. Begründung:

- Das verbleibende Datenmodell (Zählpunkte, 15-Minuten-Reihen, Prognosen, Ladefenster, Speicherkonfiguration) ist über alle EEGs gleichförmig und deutlich weniger sensibel als Finanzdaten.
- Eine Instanz ist ehrenamtlich betreibbar; N Instanzen sind es auf Dauer nicht.
- Die IBM-Regelschleife ist bereits cloud-förmig: Gateways pollen ausschließlich ausgehend per HTTPS mit Token je Anlage. Ein neuer Mandant bedeutet neue Zeilen und Tokens, keinen neuen Server.

Konsequenz: **Jede Query ist mandantenbezogen.** Alle Fachtabellen tragen eine `tenant_id`; es gibt keinen Codepfad ohne Mandantenfilter. Messdaten sind personenbezogene Daten, je EEG wird ein Auftragsverarbeitungsvertrag geschlossen.

## Module

```
EEG-Faktura ──Export/API──▶ pipeline ──▶ PostgreSQL ◀── platform (SvelteKit)
Open-Meteo  ──────────────▶    │                            │  ▲
                               └─▶ Prognoselauf             │  │ HTTPS-Polling (Token je Anlage)
                                                            ▼  │
                                                     gateway (beim Mitglied)
                                                            │
                                                            ▼
                                                     Wechselrichter (Modbus etc.)
```

### platform/ (SvelteKit 5, Tailwind 4, adapter-node)

- Mandantenfähige Weboberfläche: Community-Dashboard, Mitgliedersicht, Prognoseseite
- IBM-API: Ladefenster-Endpunkte, Statusmeldungen der Gateways
- Auth per Magic-Link (passwortlos), Autorisierung nach Rolle (Mitglied, Vorstand) und Mandant
- Zeitzone durchgehend Europe/Vienna; Vorsicht bei Datumslogik

### pipeline/ (Python)

- EEG-Faktura-Import (Export-Dateien und API) je Mandant
- Erkennung unvollständiger Lieferungen (Anteil meldender Zählpunkte, vgl. `MIN_REPORTING_SHARE` in ISCHLSTROM)
- Wetterimport Open-Meteo je Standort des Mandanten
- Prognoselauf je Mandant; Läufe werden versioniert gespeichert und nie überschrieben, damit Prognose und Ist vergleichbar bleiben
- Läuft als geplanter Job (eine Pipeline, Schleife über Mandanten)

### gateway/ (Installation beim Mitglied)

- Je Wechselrichterprofil ein Paket: Hardware-Stückliste, Verkabelungs- und Einrichtungsanleitung, Steuerlogik (OpenHAB-Regeln bzw. Skripte)
- Kommuniziert ausschließlich ausgehend zur Plattform; kein eingehender Zugriff ins Heimnetz nötig
- Fail-Safe: Ist die Plattform nicht erreichbar, fällt die Anlage auf ihr Standardverhalten zurück (Auto-Revert). Dieses Verhalten ist je Profil dokumentiert und vor Ort getestet.

## Schema-Hoheit

Anders als im ISCHLSTROM-Monorepo (Django migriert, SvelteKit liest per Raw-SQL) gibt es in Stromkreis **eine** Schema-Autorität. Entscheidung bei Projektstart: Migrationen leben bei der Plattform; die Pipeline konsumiert das Schema als dokumentierten Vertrag.

Werkzeug (August 2026): **dbmate**. Migrationen sind reines SQL unter `platform/db/migrations/`; das generierte `platform/db/schema.sql` ist eingecheckt und ist der Vertrag, den die Pipeline liest. Referenzen zwischen Fachtabellen nutzen zusammengesetzte Fremdschlüssel über `(tenant_id, id)`, damit mandantenübergreifende Verweise schon auf Datenbankebene scheitern.

## Wichtige Datenmodell-Eckpunkte

- `tenant`: EEG mit Name, Standort (für Wetter), Branding-Minimum
- `measurement_point`, `member`: einfaches Verzeichnis je Mandant, admin-gepflegt oder CSV-Import
- 15-Minuten-Reihen aus EEG-Faktura; `Anteil gemeinschaftliche Erzeugung` = gesamte Gemeinschaftserzeugung, `Eigendeckung` = tatsächlich verbrauchter Anteil (Semantik aus ISCHLSTROM übernehmen)
- `forecast_run` / `forecast`: versionierte Prognoseläufe
- `battery_site`: Anlage mit Wechselrichterprofil, Gateway-Token, Ladefenster-Konfiguration
- Materialisierte Sichten für Tages-/Wochenaggregation je Mandant

## Verhältnis zu ISCHLSTROM

Das Repo `Energiegemeinschaft` bleibt bestehen (Website, Finanzen, Onboarding). ISCHLSTROM bleibt vorerst auf eigener Infrastruktur; ein späterer Umzug auf die Plattform ist eine Option, keine Voraussetzung. Erster Mandant ist der Dummy **Salzkammerstrom** (Testdaten), an dem Import, Prognose und Dashboards durchgängig entwickelt und geprüft werden. ISCHLSTROM bleibt Referenzimplementierung und Portierungsquelle:

- `notebooks/energyData/`, `notebooks/eegfaktura/` → pipeline (Import)
- `notebooks/forecast/eeg_forecast.py` → pipeline (Prognose)
- `notebooks/weather/backfill_openmeteo.py` → pipeline (Wetter)
- `website/src/lib/server/db/energy`, `db/weather`, Energie-Routen, `/vorhersage` → platform
- `website/src/routes/api/eeginfo/*` (ladefenster, crossover), `api/ibm/status` → platform (IBM-API)
- `Batteriemanagement/`, `openhab/`, Wechselrichterprofile → gateway
