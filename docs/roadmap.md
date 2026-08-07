# Roadmap

## Phase 0: Validierung (August bis Herbst 2026)

- Gespräche mit 2 bis 3 EEGs mit EEG-Faktura-Anbindung und speicherbesitzenden Mitgliedern; Ziel: eine Pilot-EEG
- Die ISCHLSTROM-Vor-Ort-Spikes (Fronius/Pfandl, Sigenergy, Deye, Victron) doppeln als Plattform-Validierung: jedes erprobte Profil wird ein Gateway-Paket
- Kontakt zu den EEG-Faktura-Maintainern: Exportformat/API stabilisieren, Pilot-EEGs finden

## Phase 1: Mandantenfähiger Datenkern (3 bis 4 Monate)

- Schema mit `tenant_id` durchgängig; Migrationsautorität bei der Plattform
- EEG-Faktura-Importer als erste und einzige Datenquelle
- Wetterimport und Prognoselauf je Mandant (portiert aus `eeg_forecast.py`)
- Dashboards und Prognoseseite
- Magic-Link-Login, Rollen Mitglied/Vorstand, Mitglieder- und Zählpunktverzeichnis (Admin-Pflege, CSV-Import)
- **Erfolgskriterium:** Der Dummy-Mandant Salzkammerstrom durchläuft die gesamte Kette (Import, Prognose, Dashboards) und bildet die ISCHLSTROM-Energieseiten funktional nach.

## Phase 2: IBM als Produkt (2 bis 3 Monate, überlappend)

- Ladefenster-API mit Token je Anlage, Status-Rückmeldung der Gateways
- Gateway-Pakete je Wechselrichterprofil: Stückliste, Anleitung, Steuerlogik
- Sicherheitsschicht: Fail-Safe-Verhalten bei API-Ausfall, Auto-Revert, dokumentierte Restrisiko-Aufklärung je Anlage
- Pilot mit einer externen Anlage, idealerweise in der Pilot-EEG
- **Erfolgskriterium:** Eine fremde Anlage lädt prognosegesteuert, ohne dass ISCHLSTROM-Personal vor Ort war.

## Phase 3: Öffnung (laufend)

- Öffentliches Repo (AGPL-3.0), Doku, Selbst-Onboarding für EEG-Vorstände
- Vereinsgründung: Träger der Plattform, Vertragspartner für AVVs, Kostenteilung
- Hardware-Kompatibilitätsliste als lebendes Dokument; neue Wechselrichterprofile als Community-Beiträge
- Weitere EEGs onboarden

## Risiken

- **Sicherheit/Haftung** ist das Hauptrisiko (Steuerung fremder Speicher). Mitigation: Fail-Safe als Startvoraussetzung, Nutzungsbedingungen über den Verein, Restrisiko-Aufklärung je Mitglied.
- **EEG-Faktura-Kopplung:** Die gesamte Datenschicht hängt an einem Upstream-Projekt. Mitigation: früher Kontakt zu den Maintainern, Importer hinter einer Schnittstelle.
- **Ehrenamts-Bandbreite:** Mitigation: eine Instanz statt vieler, Automatisierung, Verein zur Lastenteilung.
