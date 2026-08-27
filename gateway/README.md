# gateway

Gateway-Pakete für das intelligente Batteriemanagement (IBM). Ein Gateway läuft beim Mitglied (typisch: OpenHAB auf einem Raspberry Pi o.ä.), holt Ladefenster ausschließlich ausgehend per HTTPS von der Plattform (Token je Anlage) und steuert den Wechselrichter lokal (Modbus TCP/RTU je nach Profil).

**Sicherheitsregeln (Startvoraussetzung je Profil, nicht optional):**

- **Fail-Safe:** Ist die Plattform nicht erreichbar, fällt die Anlage auf ihr Standardverhalten zurück.
- **Auto-Revert:** Jede Steuerungsvorgabe läuft ohne Verlängerung automatisch ab; vor Ort getestet.
- **Risikoaufklärung:** Je Anlage wird das Restrisiko schriftlich dokumentiert und vom Mitglied bestätigt.

## Aufbau

- `profiles/<wechselrichter>/` - je Profil: Hardware-Stückliste, Verkabelungs- und Einrichtungsanleitung, Steuerlogik (OpenHAB-Regeln bzw. Skripte), dokumentiertes Fail-Safe-Verhalten
- Gemeinsame Teile (API-Anbindung, Ladefenster-Logik, Statusmeldung) werden aus `Batteriemanagement/openhab/{control,eeg-api,setup}` des ISCHLSTROM-Repos portiert und mandantenfähig gemacht (konfigurierbare Plattform-URL und Tokens statt fixer ISCHLSTROM-Endpunkte).

## Einrichtung (SD-Karten-Image von der Plattform)

Die Plattform baut je Anlage ein fertiges SD-Karten-Image (openHABian plus Konfigurationsdateien auf der Boot-Partition, `platform/src/lib/server/gateway-image.js`); der Betreiber flasht es mit dem Raspberry Pi Imager, mehr ist am Rechner nicht zu tun. Auf der Karte liegt kein Token und kein Plattform-Passwort, nur der Einrichtungscode (60 Tage gültig) und die Plattform-URL. Ablauf beim ersten Boot:

1. cloud-init (NoCloud, `user-data` auf der Boot-Partition) installiert die systemd-Unit `stromkreis-firstboot` (Quelle: `platform/src/lib/server/gateway-firstboot/`, die Plattform bettet sie ins Image ein).
2. `stromkreis-firstboot` wartet die openHABian-Erstinstallation ab, lädt dann `https://stromkreis.net/gateway/install.sh` (`platform/static/gateway/install.sh`) und führt es aus.
3. `install.sh` tauscht den Code gegen Konfiguration samt Anlagen-Token (`POST /api/gateway/provision/v1`), schreibt `/etc/stromkreis/gateway.conf` und meldet den Fortschritt (`POST /api/gateway/provision/v1/result`); die Phase erscheint live im Dashboard. Solange das Gateway-Paket des Profils noch nicht veröffentlicht ist, endet der Lauf mit "unvollständig" und wiederholt sich alle 10 Minuten; sobald `/gateway/<profil>.tgz` existiert, setzt die Einrichtung automatisch fort.

## Profile

| Profil | Quelle im ISCHLSTROM-Repo | Status |
|---|---|---|
| `profiles/fronius/` (Symo Hybrid) | `Batteriemanagement/openhab/inverters/fronius` | Vor-Ort-Erprobung Aug 2026 |
| `profiles/fronius-snapinverter/` | `Batteriemanagement/openhab/inverters/fronius-snapinverter` | Vor-Ort-Erprobung Aug 2026 |
| `profiles/sigenergy/` | `Batteriemanagement/openhab/inverters/sigenergy` | Spike offen (Auto-Revert, mySigen-Zugriff) |
| `profiles/deye/` (SG05LP3) | `Batteriemanagement/openhab/inverters/deye` | Spike offen (RS485-Gateway, TOU/EEPROM/Fail-Safe) |
| `profiles/victron/` | `Batteriemanagement/openhab/inverters/victron` | Spike offen (DVCC vs. MPPT, Reg 2700, Venus 3.50+) |
