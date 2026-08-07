# Vision

## Warum Stromkreis

Österreichische Energiegemeinschaften haben inzwischen gute kommerzielle Angebote für Gründung, Verwaltung und Abrechnung (energiedigital, enixi, autonoma, energyfamily u.a.) sowie mit EEG-Faktura ein offenes Community-Projekt für Abrechnung und Marktkommunikation. Was fehlt: eine gemeinnützige Plattform für das, was *nach* der Abrechnung kommt - Energiedaten verständlich machen, die nahe Zukunft prognostizieren und Heimspeicher so steuern, dass sie der Gemeinschaft nützen.

ISCHLSTROM hat diese Bausteine für den eigenen Bedarf gebaut und im Realbetrieb erprobt. Stromkreis generalisiert sie und stellt sie anderen EEGs zur Verfügung: quelloffen, zum Selbstkostenpreis, gemeinschaftlich getragen.

## Leitprinzipien

1. **Von EEGs für EEGs.** Träger ist ein gemeinnütziger Verein; teilnehmende Gemeinschaften haben eine Stimme. Es wird kein Gewinn erwirtschaftet.
2. **Ergänzen statt konkurrieren.** EEG-Faktura ist die Datenquelle, nicht der Gegner. Abrechnung, Marktkommunikation und Mitgliederverwaltung bleiben außerhalb des Scopes.
3. **Im Realbetrieb erprobt.** Jedes Feature läuft zuerst produktiv bei ISCHLSTROM (Referenzinstallation), bevor es anderen EEGs angeboten wird.
4. **Sicherheit vor Funktion.** Beim Batteriemanagement gilt: Fail-Safe-Verhalten, Auto-Revert und eine schriftliche Risikoaufklärung je teilnehmendem Mitglied sind Startvoraussetzungen, nicht Politur.

## Scope-Entscheidung (August 2026)

Bewusst enthalten:

- EEG-Faktura-Datenimport inkl. Erkennung unvollständiger Lieferungen
- Dashboards für Mitglieder und Vorstand, Prognoseseite
- Wetterimport und Energieprognose je Gemeinschaft
- Intelligentes Batteriemanagement: Ladefenster-Berechnung, Gateway-API, Wechselrichterprofile

Bewusst ausgeschlossen:

- Finanzfeatures (Buchhaltung, SEPA, Bankimport)
- Mitglieder-Onboarding und Beitrittsprozesse
- Netzbetreiber-Integrationen und Marktkommunikation
- Abrechnung jeglicher Art

Minimal notwendig bleibt: Login per Magic-Link, damit Mitglieder ihre eigenen Daten und ihren Speicherstatus sehen, sowie ein einfaches Verzeichnis von Mitgliedern und Zählpunkten je Mandant (vom EEG-Admin gepflegt oder per CSV importiert).

## Zielgruppe

EEGs mit EEG-Faktura-Anbindung, insbesondere solche mit speicherbesitzenden Mitgliedern. Das Batteriemanagement ist das Alleinstellungsmerkmal: keine kommerzielle Plattform in Österreich steuert Mitgliederspeicher prognosebasiert.
