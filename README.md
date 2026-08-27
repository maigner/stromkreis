# Stromkreis

**Die offene Plattform von Energiegemeinschaften für Energiegemeinschaften.**

Stromkreis ist eine gemeinnützige, quelloffene Plattform für österreichische Energiegemeinschaften (EEGs). Sie entsteht aus der digitalen Infrastruktur von [ISCHLSTROM](https://ischlstrom.org) und macht deren erprobte Bausteine für andere Gemeinschaften nutzbar. Kein kommerzielles Produkt: Betrieb zum Selbstkostenpreis, getragen von den teilnehmenden EEGs.

## Was Stromkreis bietet

**1. Energiedaten:** Import der Energiedaten aus EEG-Faktura, Qualitätsprüfung unvollständiger Lieferungen, Aufbereitung als Tages- und Wochenübersichten, Wetterdaten (Open-Meteo) und eine Prognose der gemeinschaftlichen Erzeugung und Deckung für die kommenden Tage. Mitglieder sehen ihre eigenen Daten, der Vorstand die Gemeinschaft als Ganzes.

**2. Batteriemanagement:** Die Plattform berechnet aus der Prognose Ladefenster für Heimspeicher. Ein Gateway beim Mitglied (z.B. OpenHAB) holt die Ladefenster per HTTPS ab und steuert den Wechselrichter. Unterstützte Geräteprofile: Fronius SnapINverter, Fronius Symo Hybrid, Sigenergy, Deye, Victron.

## Was Stromkreis bewusst nicht ist

- **Keine Abrechnung:** Dafür gibt es [EEG-Faktura](https://eegfaktura.at). Stromkreis baut darauf auf und konkurriert nicht damit.
- **Kein Mitglieder-Onboarding:** Beitrittsprozesse und Netzbetreiber-Datenfreigaben bleiben Sache der einzelnen EEG.
- **Keine Finanzverwaltung:** Buchhaltung und SEPA sind nicht Teil der Plattform.

## Aufbau des Repositories

| Verzeichnis | Inhalt |
|---|---|
| `platform/` | SvelteKit-Webanwendung: mandantenfähige Plattform (Dashboards, Prognose, IBM-API) |
| `pipeline/` | Python-Datenpipeline: EEG-Faktura-Import, Wetterimport, Prognoselauf |
| `gateway/` | Gateway-Pakete je Wechselrichterprofil für die Installation beim Mitglied |
| `docs/` | Vision, Architektur, Roadmap |

## Status

Projektstart August 2026. Die Plattform wird unter **stromkreis.net** betrieben. Referenzinstallation und Tenant Nr. 1 ist ISCHLSTROM. Details in [docs/roadmap.md](docs/roadmap.md).

## Lizenz

[AGPL-3.0](LICENSE)
