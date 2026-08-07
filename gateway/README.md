# gateway

Gateway-Pakete für das intelligente Batteriemanagement (IBM). Ein Gateway läuft beim Mitglied (typisch: OpenHAB auf einem Raspberry Pi o.ä.), holt Ladefenster ausschließlich ausgehend per HTTPS von der Plattform (Token je Anlage) und steuert den Wechselrichter lokal (Modbus TCP/RTU je nach Profil).

**Sicherheitsregeln (Startvoraussetzung je Profil, nicht optional):**

- **Fail-Safe:** Ist die Plattform nicht erreichbar, fällt die Anlage auf ihr Standardverhalten zurück.
- **Auto-Revert:** Jede Steuerungsvorgabe läuft ohne Verlängerung automatisch ab; vor Ort getestet.
- **Risikoaufklärung:** Je Anlage wird das Restrisiko schriftlich dokumentiert und vom Mitglied bestätigt.

## Aufbau

- `profiles/<wechselrichter>/` - je Profil: Hardware-Stückliste, Verkabelungs- und Einrichtungsanleitung, Steuerlogik (OpenHAB-Regeln bzw. Skripte), dokumentiertes Fail-Safe-Verhalten
- Gemeinsame Teile (API-Anbindung, Ladefenster-Logik, Statusmeldung) werden aus `Batteriemanagement/openhab/{control,eeg-api,setup}` des ISCHLSTROM-Repos portiert und mandantenfähig gemacht (konfigurierbare Plattform-URL und Tokens statt fixer ISCHLSTROM-Endpunkte).

## Profile

| Profil | Quelle im ISCHLSTROM-Repo | Status |
|---|---|---|
| `profiles/fronius/` (Symo Hybrid) | `Batteriemanagement/openhab/inverters/fronius` | Vor-Ort-Erprobung Aug 2026 |
| `profiles/fronius-snapinverter/` | `Batteriemanagement/openhab/inverters/fronius-snapinverter` | Vor-Ort-Erprobung Aug 2026 |
| `profiles/sigenergy/` | `Batteriemanagement/openhab/inverters/sigenergy` | Spike offen (Auto-Revert, mySigen-Zugriff) |
| `profiles/deye/` (SG05LP3) | `Batteriemanagement/openhab/inverters/deye` | Spike offen (RS485-Gateway, TOU/EEPROM/Fail-Safe) |
| `profiles/victron/` | `Batteriemanagement/openhab/inverters/victron` | Spike offen (DVCC vs. MPPT, Reg 2700, Venus 3.50+) |
