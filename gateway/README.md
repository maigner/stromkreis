# gateway

Gateway-Pakete für das Speichermanagement. Ein Gateway läuft beim Mitglied (openHABian auf einem Raspberry Pi), holt Ladefenster, Crossover-Zeiten und Wolkenvorschau ausschließlich ausgehend per HTTPS von der Plattform (Anlagen-Token je Anlage) und steuert den Wechselrichter lokal (Modbus TCP bzw. Solar-API je nach Profil). Portiert aus dem ISCHLSTROM-Repo (`Batteriemanagement/openhab/`), generisch für alle EEGs: keine Referenzen mehr auf die ISCHLSTROM-Infrastruktur.

Fernwartung und Fernzugriff laufen ebenfalls über Stromkreis-Infrastruktur, beides als Container im Compose-Stack am Server (bei ISCHLSTROM war WireGuard nativ installiert):

- **WireGuard-Fernwartung** (`deploy/wireguard/`): jeder Pi baut einen ausgehenden Tunnel ins Wartungsnetz `10.88.0.0/24` auf (Server ist `.1`, Anlagen ab `.11`; am Router des Mitglieds bleibt alles zu). Die Tunnel-IP vergibt die Plattform bei der Provisionierung; den Public-Key meldet der Pi in der Phase "Fernwartung", der WireGuard-Container gleicht die Peers jede Minute mit der Plattform ab (`/api/gateway/sync/wireguard-peers`). Zugriff: die SSH-Konsole auf der Anlagen-Detailseite (echtes SSH; die Plattform verbindet sich durch den SOCKS-Durchgang des WireGuard-Containers und meldet sich als `openhabian` mit dem Anlagen-Passwort an) oder `deploy/wg-ssh.sh <tunnel-ip>` vom Terminal.
- **Stromkreis-eigene openHAB Cloud** (`hac.stromkreis.net`, Compose-Dienste `cloud-app`/`cloud-mongodb`/`cloud-redis`): Mitglieder erreichen ihre Main UI von unterwegs (openHAB-App mit `https://hac.stromkreis.net` als Remote-URL, Browser über `https://remote.hac.stromkreis.net`). Die Konten legt der Dienst `cloud-sync` automatisch an (Zugangsdaten auf der Anlagen-Detailseite); die Registrierung auf der Cloud ist abgeschaltet. Push-Benachrichtigungen der offiziellen Apps funktionieren über eine eigene Cloud prinzipbedingt nicht.

**Sicherheitsregeln (Startvoraussetzung je Profil, nicht optional):**

- **Fail-Safe:** Ist die Plattform nicht erreichbar, fällt die Anlage auf ihr Standardverhalten zurück.
- **Auto-Revert:** Jede Steuerungsvorgabe läuft ohne Verlängerung automatisch ab; vor Ort getestet.
- **Risikoaufklärung:** Je Anlage wird das Restrisiko schriftlich dokumentiert und vom Mitglied bestätigt.

## Aufbau

- `openhab/` - das Gateway-Paket (wird als `stromkreis-gateway.tgz` an die Anlagen ausgeliefert):
  - `setup/` - Einrichtungsskripte: `install-gateway.sh` (Gesamtablauf), `00-provision.sh` (Profil-Erkennung, Konfiguration vervollständigen), `01`-`06` (Preflight, Addons, Things, Items, Regeln, Overview-Seiten, Verify), `07` (openHAB-Cloud-Identität), `08` (WireGuard-Fernwartung), `09` (Selbst-Update-Timer `stromkreis-update`), `10` (Standardpasswörter), `purge-gateway.sh` (vollständiger Rückbau für erneute Tests), `build-dist.sh` (packt das Paket nach `platform/static/gateway/`), `lib/common.sh` (gemeinsame Helfer).
  - `control/` - Steuerungskern `core.js` (Ladesperre, forcierte Entladung, Laderegelung, Netzladeschutz, Kapazitäts-/Hauslast-Schätzung) und `netzeinspeisung.js`.
  - `api/` - Anbindung an die Plattform: `status_push.js` (minütlich), `ladefenster.js`, `crossover.js`, `cloud_forecast.js`.
  - `inverters/<profil>/` - je Wechselrichterprofil `profile.sh` (Kontrakt), `adapter.js`, `overview.yaml` (Main-UI-Seiten), teils `rediscover.sh` (Netzwerk-Watchdog) und Simulatoren unter `tools/`.
- `profiles/<profil>/` - Hardware-Stückliste, Verkabelungs- und Einrichtungsanleitung, Fail-Safe-Doku je Profil (Dokumentation, nicht Teil des Pakets).

Die Konfiguration einer Anlage liegt in `/etc/stromkreis/gateway.conf` (schreibt der Bootstrap), das Paket unter `/opt/stromkreis/openhab`.

## Einrichtung (SD-Karten-Image von der Plattform)

Die Plattform baut je Anlage ein fertiges SD-Karten-Image (openHABian plus Konfigurationsdateien auf der Boot-Partition, `platform/src/lib/server/gateway-image.js`); der Betreiber flasht es mit dem Raspberry Pi Imager. Auf der Karte liegt kein Token und kein Plattform-Passwort, nur der Einrichtungscode (60 Tage gültig) und die Plattform-URL. Ablauf beim ersten Boot:

1. cloud-init (NoCloud, `user-data` auf der Boot-Partition) installiert die systemd-Unit `stromkreis-firstboot`.
2. `stromkreis-firstboot` wartet die openHABian-Erstinstallation ab (30 bis 45 Minuten), lädt dann `https://stromkreis.net/gateway/install.sh` und führt es aus.
3. `install.sh` tauscht den Code gegen die Konfiguration samt Anlagen-Token (`POST /api/gateway/provision/v1`), lädt `stromkreis-gateway.tgz` (Prüfsummen-geprüft), entpackt nach `/opt/stromkreis/openhab` und startet `setup/install-gateway.sh`. Jeder Schritt meldet seine Phase (`POST /api/gateway/provision/v1/result`); der Fortschritt erscheint live auf der Anlagen-Detailseite.
4. Exit 75 heißt "unvollständig, später erneut" (z. B. Wechselrichter nicht im Netz, Passwort fehlt noch): `stromkreis-firstboot` wiederholt den Lauf alle 10 Minuten, bis alles fertig ist.

Updates laufen über denselben Bootstrap: der root-Timer `stromkreis-update` (alle 10 Minuten) prüft nachts die Paket-Prüfsumme auf der Plattform und spielt neue Stände automatisch ein. Betriebssystem-Updates spielt unattended-upgrades täglich automatisch ein (alle openHABian-Paketquellen inklusive Kernel und Pi-Firmware, bewusst ohne das openHAB-Repo); verlangt ein Update einen Neustart, rebootet der Pi um 02:30.

## Plattform-Endpunkte für die Gateways

Alle mandantenbezogen über den Anlagen-Token (POST mit `{"token": ...}`):

| Endpunkt | Zweck |
|---|---|
| `POST /api/gateway/provision/v1` | Einrichtungscode gegen Konfiguration + Token tauschen |
| `POST /api/gateway/provision/v1/result` | Einrichtungsphase melden (Antwort trägt z. B. das Profil) |
| `POST /api/gateway/provision/v1/secret` | Wechselrichter-Passwort abholen (bleibt verschlüsselt auf der Plattform, für Neuinstallationen) |
| `POST /api/gateway/status/v1` | Status-Push (Ladestand, Leistungen, Einstellungen, Log, Systemwerte) |
| `POST /api/gateway/ladefenster/v1` | Ladesperre-Fenster aus der Tagesprognose, je Anlage individualisiert |
| `POST /api/gateway/crossover/v1` | mittlere Crossover-Zeiten der letzten vollständigen Messtage |
| `POST /api/gateway/wolken/v1` | Bewölkung des nächsten Mittagsfensters plus Stundenwerte |

Stack-intern (Auth `GATEWAY_SYNC_TOKEN` aus der Server-`.env`): `GET /api/gateway/sync/wireguard-peers` (Peer-Liste für den WireGuard-Container), `GET /api/gateway/sync/cloud-accounts` und `POST /api/gateway/sync/cloud-result` (Konten-Sync im Cloud-Container).

## Test auf dem Raspberry Pi

Voraussetzungen: Raspberry Pi (64-bit, empfohlen Pi 4 mit 2 GB oder mehr), SD-Karte ab 16 GB, LAN-Kabel. Ein Wechselrichter ist für den Test nicht nötig; ohne ihn endet die Einrichtung planmäßig in "Wartet, wird automatisch fortgesetzt".

0. **Einmalig am Server:** DNS-A-Records `hac.stromkreis.net` und `remote.hac.stromkreis.net` auf den Server, Router-Weiterleitung UDP 51820 auf den Server (WireGuard). Die Caddy-Vhosts und die `.env`-Werte (`GATEWAY_SYNC_TOKEN`, `EXPRESS_KEY`, `CLOUD_*`, `WG_ENDPOINT`) sind eingerichtet. Ohne diese Schritte läuft der Rest trotzdem: fehlt der WireGuard-Public-Key oder `CLOUD_BASE_URL`, lässt die Plattform die Teile am Gateway einfach aus.
1. **Deployen:** `deploy/deploy.sh` baut jetzt auch das Gateway-Paket und legt es unter `https://stromkreis.net/gateway/stromkreis-gateway.tgz` ab.
2. **Anlage anlegen:** auf `/intern` (Tab Anlagen) "Neue Anlage für ein Mitglied", Wechselrichterprofil setzen (im Testnetz ohne Wechselrichter unbedingt setzen, sonst wartet der Pi in "Wechselrichter nicht eindeutig"). Optional WLAN-Zugang; LAN bleibt die Empfehlung.
3. **Image bauen und flashen:** auf der Anlagen-Detailseite "Image erstellen" (dauert einige Minuten; ein Deploy während des Baus bricht ihn ab), dann "Image herunterladen" und mit dem Raspberry Pi Imager ("Eigenes Image", ohne OS-Anpassungen) oder balenaEtcher flashen.
4. **Booten und zusehen:** Karte in den Pi, LAN und Strom anstecken. openHABian installiert sich selbst (30 bis 45 Minuten, ein Neustart), danach laufen die Phasen auf der Anlagen-Detailseite durch: Konfiguration, Passwörter, openHAB-Erweiterungen, Wechselrichter, Datenpunkte, Steuerung, Oberfläche. Erwartetes Ende ohne Wechselrichter: "Wartet, wird automatisch fortgesetzt" - das ist der gewollte Endzustand des Tests, kein Fehler. Mit Wechselrichter im selben Netz läuft die Einrichtung bis "Einrichtung abgeschlossen".
5. **Wechselrichter-Passwort (nur Fronius GEN24):** auf der Anlagen-Detailseite unter "Zugang zum Wechselrichter" eintragen; das Gateway holt es innerhalb weniger Minuten ab und trägt es ins Bridge-Thing ein.
6. **Prüfen:** Die Anlage erscheint auf `/intern` als Online (Status-Push jede Minute); `http://<pi>:8080` zeigt die Main UI mit den Stromkreis-Seiten (Admin-Konto `admin`, Passwort = Linux-Passwort der Anlage, steht in der `openhabian.conf` des Images bzw. am Gateway in `/etc/stromkreis/gateway.conf`). Fernwartung: auf der Anlagen-Detailseite "SSH-Konsole öffnen" (Terminal direkt im Browser) oder `deploy/wg-ssh.sh <tunnel-ip>`. Cloud: Anmeldung auf `https://hac.stromkreis.net` mit dem Cloud-Konto der Anlage (Detailseite), die Anlage muss dort als Online erscheinen; `https://remote.hac.stromkreis.net` zeigt die Main UI. Am Pi: `journalctl -u stromkreis-firstboot -f` bzw. `/var/log/stromkreis-firstboot.log`.
7. **Wiederholen:** `sudo /opt/stromkreis/openhab/setup/purge-gateway.sh` baut alles zurück (Marker inklusive); mit "Neuer Code" und neu gebautem Image startet der Test von vorn.

## Profile

| Profil | Status |
|---|---|
| `fronius-symo` (GEN24/Symo Hybrid) | Vor-Ort-Erprobung Aug 2026 (ISCHLSTROM), portiert |
| `fronius-snapinverter` | Vor-Ort-Erprobung Aug 2026 (ISCHLSTROM), portiert |
| `sigenergy` | portiert; Spike offen (Auto-Revert, mySigen-Zugriff) |
| `deye` (SG05LP3) | portiert; Spike offen (RS485-Gateway, TOU/EEPROM/Fail-Safe) |
| `victron` | portiert; Spike offen (DVCC vs. MPPT, Reg 2700, Venus 3.50+) |
