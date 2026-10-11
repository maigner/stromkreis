# Sicherheit der Gateways: was die Plattform kann, was nicht, und was bleibt

Stand: 11. Oktober 2026. Diese Beschreibung ist Teil der Restrisiko-Offenlegung, die Stromkreis jedem Mitglied schuldet, das ein Gateway betreibt (siehe `docs/vision.md`: Sicherheitsregeln sind Startvoraussetzung). Sie ist bewusst ohne Beschoenigung geschrieben. Anlass war eine Quelltextpruefung von aussen im September 2026 (Befunde S1 bis S7), deren Punkte in vier Phasen abgearbeitet wurden; der Stand steht in `docs/status.md`.

## 1. Was ein Gateway ist

Ein Raspberry Pi im Haus des Mitglieds mit openHABian, der den Wechselrichter bzw. den Heimspeicher im lokalen Netz steuert und mit der Plattform `stromkreis.net` spricht. Er wird vom Betreiber der Energiegemeinschaft per fertigem SD-Karten-Image eingerichtet. Der Pi ist ein **verwalteter Apparat**: die Plattform darf ihn aktualisieren und warten, damit die Steuerung ueber Jahre laeuft, ohne dass das Mitglied selbst Hand anlegen muss. Dafuer hat die Plattform weitreichende Rechte auf dem Pi. Dieses Dokument macht sie sichtbar.

## 2. Was die Plattform auf dem Pi kann

Drei Wege fuehren zu root-Rechten auf dem Pi. Alle drei sind Absicht.

1. **Fernwartung per SSH durch den Wartungstunnel.** Der Pi baut einen ausgehenden WireGuard-Tunnel zum Server auf (am Router des Mitglieds wird nichts geoeffnet). Durch diesen Tunnel meldet sich die Plattform als Benutzer `openhabian` mit dem Anlagen-Passwort an und fuehrt mit `sudo` eine feste Liste von Wartungsaktionen aus: Neustart, openHAB neu starten, Gateway-Paket aktualisieren, System-Updates einspielen, sowie Abfragen (Systemzustand, Protokolle, Pruefung der Einrichtung). Die Befehle stehen im Quelltext (`platform/src/lib/server/gateway-ssh.js`); aus dem Browser kommt nur die Kennung der Aktion, nie Befehlstext. Eine freie Shell gibt es nur fuer den Serverbetreiber direkt am Server (`deploy/wg-ssh.sh`).
2. **Selbst-Update als root.** Ein Timer (`stromkreis-update.timer`, alle 10 Minuten geprueft, naechtliches Fenster 03:00 bis 05:00) laedt `install.sh` von der Plattform und spielt das Gateway-Paket neu ein, wenn sich dessen Pruefsumme geaendert hat oder der Betreiber ein Update angefordert hat. Das Paket enthaelt die Einrichtungsskripte und die Steuerungslogik.
3. **Erster Start.** `stromkreis-firstboot` laedt `install.sh` und richtet den Pi als root ein.

Das Gateway-Paket ist seit Oktober 2026 **signiert** (Ed25519). Der private Schluessel liegt nicht auf dem Server, sondern nur auf dem Rechner, von dem aus deployt wird. `install.sh` prueft die Signatur vor dem Einspielen; den Public-Key bekommt der Pi bei der Einrichtung und schreibt ihn in `/etc/stromkreis/gateway.conf` fest (`STROMKREIS_PACKAGE_PUBKEY`). Ein uebernommener Server oder ein Angriff auf die TLS-Verbindung kann dem Pi damit **kein fremdes Paket** mehr unterschieben. Nicht signiert ist `install.sh` selbst; es ist klein, liegt im Repository (`platform/static/gateway/install.sh`) und kann jederzeit mit dem Stand auf der Plattform verglichen werden. Ein manipuliertes `install.sh` koennte die Signaturpruefung umgehen; das ist das verbleibende Fenster und steht in Abschnitt 6.

## 3. Was die Plattform nicht kann, und was ein Pi nicht kann

- **Daten anderer Mitglieder** sieht ein Gateway nicht. Mit seinem Anlagen-Token bekommt es nur Gemeinschaftswerte (Ladefenster, Crossover-Zeiten, Wetter) und seine eigene Konfiguration.
- **Andere Gateways** erreicht ein Pi nicht. Das Wartungsnetz laesst nur Verbindungen vom Server zu den Gateways zu: der SOCKS-Durchgang im WireGuard-Container lauscht nicht auf der Tunnel-Adresse, Weiterleitung zwischen den Tunneln ist abgeschaltet, und die Firewall des Containers nimmt auf dem Tunnel nur Antworten an. Ein gestohlener oder uebernommener Pi kommt damit weder an andere Pis noch an die Datenbanken des Servers.
- **EEGFaktura-Zugaenge** liegen nicht auf dem Pi. Die Refresh-Tokens des Betreibers sind in der Plattform-Datenbank verschluesselt; der Schluessel existiert nur in den Plattform-Containern.
- **Passwoerter im Browser**: Linux-, WLAN- und Wechselrichter-Passwort liegen verschluesselt in eigenen Spalten und erreichen nur die Detailseite eines Betreibers, nie die Anlagenliste und nie einen Vorstand oder ein Mitglied.
- **Host-Key-Pruefung**: der Pi meldet seinen SSH-Host-Key bei der Einrichtung; die Plattform verbindet sich nur, wenn der Pi genau diesen Schluessel vorzeigt. Ein Geraet, das sich im Tunnel als das Gateway ausgibt, bekommt das Anlagen-Passwort nicht zu sehen.

## 4. Wie ein Mitglied das nachpruefen kann

Alles auf dem Pi ist einsehbar (Anmeldung lokal mit `openhabian` und dem Anlagen-Passwort, das der Betreiber auf der Anlagen-Detailseite sieht):

```sh
sudo cat /etc/stromkreis/gateway.conf          # Konfiguration inkl. Signaturschluessel (Token und Passwoerter stehen dort auch)
systemctl list-timers 'stromkreis-*'            # welche Timer laufen (Update, Fail-Safe)
sudo cat /usr/local/sbin/stromkreis-update      # was der Updater genau tut
sudo tail /var/log/stromkreis-update.log        # wann was eingespielt wurde
sudo journalctl -u ssh | grep 10.88.0.1         # jede Fernwartungs-Anmeldung der Plattform
sudo wg show wg0                                # Tunnel: Gegenstelle, letzter Handshake, Datenmenge
ls /opt/stromkreis/openhab/setup                # die Einrichtungsskripte, die als root laufen
```

Jede Fernwartungsaktion steht auch im Plattform-Log (`fernwartung: mandant ... anlage ... aktion ...`). Der Quelltext von Plattform und Gateway-Paket ist oeffentlich (AGPL-3.0): <https://github.com/maigner/stromkreis>.

## 5. Wie ein Mitglied das einschraenken kann

Beides sind Eintraege in `/etc/stromkreis/gateway.conf`, danach `sudo /opt/stromkreis/openhab/setup/install-gateway.sh`:

- `INSTALL_WIREGUARD=0`: kein Wartungstunnel. Die Steuerung laeuft weiter (sie spricht nur ausgehend per HTTPS mit der Plattform), aber die Fernwartung entfaellt; bei Problemen muss der Betreiber vor Ort oder das Mitglied selbst eingreifen.
- `INSTALL_AUTO_UPDATE=0`: kein Selbst-Update. Das Gateway bleibt auf dem Stand, den es hat, auch bei Sicherheitskorrekturen; Updates sind dann Handarbeit (`sudo stromkreis-update --now` nach eigener Pruefung).

Wer beides abschaltet, betreibt den Pi faktisch selbst. Das ist zulaessig, nimmt der Gemeinschaft aber die Moeglichkeit, Fehler in der Steuerung schnell fuer alle zu beheben.

## 6. Restrisiken (offen)

- **Vertrauen in `install.sh` und in den ersten Kontakt.** Beim ersten Start holt der Pi Konfiguration, Public-Key und `install.sh` ueber HTTPS von der Plattform. Wer in diesem Moment Server oder Verbindung kontrolliert, bestimmt, welchem Schluessel der Pi ab dann vertraut. Gleiches gilt fuer Gateways, die vor der Signatur eingerichtet wurden: sie uebernehmen den Schluessel der Plattform beim naechsten Update (TOFU). Spaeter kann ein manipuliertes `install.sh` die Pruefung umgehen; dagegen hilft nur der Vergleich mit dem Repository.
- **Root ueber das Anlagen-Passwort.** Das Passwort liegt verschluesselt auf der Plattform; wer Plattform-Datenbank und Schluessel (`TOKEN_SECRET`) zugleich hat, kann jedes Gateway per Tunnel als root bedienen. Das ist die Kehrseite der Fernwartung und laesst sich nur mit `INSTALL_WIREGUARD=0` ausschliessen.
- **Ein Server fuer alle Gemeinschaften.** Mandanten sind in der Anwendung getrennt (jede Abfrage ist mandantengebunden, Fremdschluessel verhindern Querverweise), aber noch nicht auf Datenbankebene (Row-Level-Security steht auf der Liste). Ein Fehler in der Plattform koennte Daten einer anderen Gemeinschaft zeigen.
- **Einrichtungscode.** 60 Bit, 14 Tage gueltig, Fehlversuche werden gebremst. Wer ihn innerhalb der Frist errät oder von der SD-Karte liest, kann die Konfiguration samt Anlagen-Token abholen und das echte Gateway ausloggen. Darum: Images nicht herumliegen lassen, nach dem Flashen "Einrichtung abgeschlossen" abwarten (dann ist der Code tot).
- **Lokales Netz des Mitglieds.** Der Pi haengt im Heimnetz und spricht mit dem Wechselrichter meist unverschluesselt (Modbus, lokale APIs). Ein Angreifer im Heimnetz kann den Wechselrichter ohnehin direkt erreichen; der Pi vergroessert diese Flaeche um einen SSH-Dienst (Passwort) und die openHAB-Oberflaeche (Port 8080, Admin-Passwort = Anlagen-Passwort).
- **Fail-Safe.** Faellt die Plattform aus, laufen Auto-Revert bzw. der Fail-Safe-Timer am Gateway und setzen den Wechselrichter auf Werksverhalten zurueck; das ist dokumentiert und getestet, aber ein Fehler dort wuerde den Speicher in einem ungewollten Zustand lassen.

## 7. Fuer den Serverbetreiber: Signaturschluessel

- Privater Schluessel: `~/.config/stromkreis/package-signing.key` (oder `STROMKREIS_SIGNING_KEY`) auf jedem Rechner, von dem aus deployt wird; nie ins Repository, nie auf den Server. Anlegen: `openssl genpkey -algorithm ed25519 -out ~/.config/stromkreis/package-signing.key` (nur einmal; auf weitere Deploy-Rechner kopieren, nicht neu erzeugen).
- Public-Key: `platform/src/lib/server/stromkreis-gateway.pub` (base64 DER), eingecheckt. `build-dist.sh` bricht ab, wenn der private Schluessel nicht dazu passt, damit nie ein Paket ausgeliefert wird, das die Gateways ablehnen wuerden.
- Schluesselwechsel: neuen Schluessel erzeugen, Public-Key einchecken, ein letztes Mal mit dem alten Schluessel ein Paket ausliefern, das per Einrichtungsskript den neuen Public-Key in `gateway.conf` eintraegt; erst danach mit dem neuen signieren. Ohne diesen Zwischenschritt lehnen alle Gateways das naechste Update ab (fail-safe, aber Handarbeit je Anlage).
