# EEG-Faktura-Testinstanz auf `server`

Vollständige lokale EEG-Faktura-Installation als Testgegenstelle für den Stromkreis-Importer und später das SSO-Login. Hintergrund, Befunde und Fallstricke: `docs/eegfaktura-lokal.md`.

Läuft auf dem Homelab-Host `server` unter `/home/martin/Container/eegfaktura/` (nicht per `deploy.sh`, eigener Ablauf). Basis ist der Upstream-Stack `eegfaktura-docker-compose` als Tarball (kein git), darüber die Dateien aus diesem Ordner. Der Upstream-Stack bleibt unverändert und lässt sich per Tarball aktualisieren.

## URLs

| Was | URL | Login |
|---|---|---|
| Kunden-SPA (EEG-Faktura) | https://eegfaktura-test.stromkreis.net | `importer` (EEG_ADMIN) oder der bei der Registrierung angelegte EEG-Admin |
| Admin-Portal (EEG-Registrierung) | https://admin.eegfaktura-test.stromkreis.net | `manager` |
| Keycloak-Konsole | https://auth.eegfaktura-test.stromkreis.net/admin/ | `admin` / `KC_ADMIN_PW` aus `secrets.env`; Caddy lässt `/admin/*` und `/realms/master/*` nur aus dem Heimnetz (192.168.178.0/24), dem Docker-Netz (172.16.0.0/12, das Admin-Backend legt Benutzer über die Admin-API an) und von der eigenen WAN-IP 85.127.8.140 (Heimnetz-Clients kommen per NAT-Hairpin mit dieser Adresse an) durch, 403 von außen. Bei Wechsel der Heim-IP anpassen |
| API für den Importer | https://eegfaktura-test.stromkreis.net (`/api/*`, `/energystore/*`) | Basic `importer` |
| Keycloak-Token-Endpunkt | https://auth.eegfaktura-test.stromkreis.net/realms/EEGFaktura/protocol/openid-connect/token | |
| EEG-Faktura-Postgres | 127.0.0.1:26432 am Server (`eegfaktura`/`eegfaktura`) | |

Alle drei Hostnamen sind A-Records in Route 53 auf die Heim-IP; TLS terminiert der Server-Caddy (`~/Container/caddy/Caddyfile`, Block "EEG-Faktura-Testinstanz", Backup `Caddyfile.bak-eegfaktura`) und leitet auf 127.0.0.1:8001/8002/8180 weiter. Die Container erreichen die Hostnamen per `extra_hosts: host-gateway` (Caddy lauscht im Host-Netz auf 443). Aus dem Internet erreichbar; alle EEG-Faktura-Ports selbst sind nur an 127.0.0.1 gebunden. Achtung beim Bearbeiten der Caddyfile: sie ist als einzelne Datei in den Caddy-Container gemountet; `sed -i` oder Editoren, die die Datei ersetzen, lassen den Container auf der alten Inode sitzen, `caddy reload` lädt dann die alte Fassung. In-place schreiben (`>>`, `cat >`) oder danach `docker compose restart` im Caddy-Ordner.

Passwörter stehen in `server:/home/martin/Container/eegfaktura/secrets.env` (Kopie zum Nachschlagen in der gitignorierten `ZUGANGSDATEN.md` im Repo-Wurzelverzeichnis) (nicht im Repo; `.env` ist ein Symlink darauf, damit Compose `${ADMIN_CLI_SECRET}` sieht). Test-EEG: RC-Nummer `TE100200`, Gemeinschafts-ID `AT00999900000TC100200000000000002`, Netzbetreiber `AT009999`. Energiedaten: 1.1.2023 bis 20.5.2023 aus der Musterdatei des Upstream-Repos (7 Zählpunkte) und 21.5.2023 bis 25.8.2026 synthetisch aus `gen-energy-report.py` (alle 11 Zählpunkte, lückenlos anschließend).

## Dateien

| Datei | Zweck |
|---|---|
| `compose.override.yaml` | Wird von Compose automatisch geladen. `restart: unless-stopped` für alle Dienste (Upstream setzt keine Restart-Policy; nach dem Server-Neustart am 24.8. blieb der Stack liegen, bis er am 26.8. per `up -d` neu gestartet wurde). Keycloak auf Port 8180 (8080 ist am Server durch Nextcloud belegt) mit `KC_HOSTNAME https://auth.eegfaktura-test.stromkreis.net` hinter Caddy (`KC_PROXY_HEADERS xforwarded`), Bootstrap-Admin-Passwort aus `.env`, alle Ports nur 127.0.0.1, Healthcheck auf Management-Port 9181, `extra_hosts` host-gateway für alle Dienste, Backend aus lokalem Build, `master-server`-Env des energystore korrigiert, admin-cli-Secret ans Admin-Backend, eda/billing/postfix im Profil `full` (laufen nicht). |
| `patch-realm.py` | Patcht `keycloak/import/realm-export.json` vor dem ersten Start: Realm-`frontendUrl` (Token-Issuer), Redirect-URIs, Client `at.ourproject.vfeeg.api` (fehlt upstream), Gruppen-Mapper `access_groups`/`groups` (fehlen upstream), festes admin-cli-Secret, Benutzer `manager` und `importer`. |
| `keycloak.json.tmpl` | Vorlage für `keycloak/keycloak.json` (Client-Konfiguration der Go-Dienste) mit Platzhaltern für die Secrets. |
| `setup-eeg.sh [eegs/<RC>.json]` | Nach dem Start: EEG aus der Konfiguration registrieren (Admin-Backend-API), Upload-Benutzer per `kc-user.sh` einrichten, Stammdaten (Backend) und Energiedaten (energystore-GraphQL) hochladen, ProtectApi-Smoke-Test. Idempotent, Uploads überschreiben. Default `eegs/TE100200.json`. |
| `kc-user.sh <user> <pw> <rc>` | Keycloak-Admin-API (127.0.0.1:8180, Realm `master`, Passwort `KC_ADMIN_PW`): Benutzer anlegen bzw. aktualisieren, festes Passwort, Gruppe `EEG_ADMIN`, `tenant`-Attribut um die RC-Nummer erweitern. Keycloak 26 verlangt beim PUT die vollständige User-Representation. |
| `gen-members.py` | Erzeugt deterministisch eine Mitglieder-Konfiguration `eegs/<RC>.json` (Namen, Adressen, Profile haushalt/wärmepumpe/gewerbe, Jahresverbrauch, ~40% mit PV, ~20% Späteinsteiger). |
| `eegs/*.json` | Konfigurationen der drei Dummy-EEGs (Tabelle oben). `TE100200.json` bildet die Upstream-Musterstammdaten nach und zeigt auf die Musterdateien. Straße und Hausnummer der Mitglieder sind seit 26.8. echte Adressen aus dem jeweiligen Ort (`set-addresses.py`). |
| `eegs/adressen.json` | Je PLZ (4820, 4822, 4802) 400 echte Wohnadressen (Straße, Hausnummer) aus OpenStreetMap (Overpass, Objekte mit `addr:street`/`addr:housenumber`, ohne Gewerbe-Tags), Stand 26.8.2026. Datenquelle: © OpenStreetMap-Mitwirkende, ODbL. |
| `set-addresses.py eegs/<RC>.json [--apply]` | Weist den Mitgliedern deterministisch (Seed = RC-Nummer) Adressen aus `adressen.json` zu und schreibt sie in die Konfiguration; mit `--apply` am Server zusätzlich in EEG-Faktura: Teilnehmer per Vor- und Nachname zuordnen, Wohn- und Rechnungsadresse per `PUT /api/participant/{id}`, Zählpunkt-Adressen per `PUT /api/meteringpoint/v2/{pid}/update/{mid}` (`{path, value}` je Feld). Braucht `secrets.env` (`API_SECRET`, `<UPLOAD_USER>_PW`). Idempotent. Die Plattform übernimmt die Adressen beim nächsten Import-Auftrag (`insert into eegfaktura_sync_job (tenant_id) ...`, Phase masterdata). |
| `gen-eeg.py <config> <von> <bis> <ordner>` | Erzeugt aus einer Konfiguration `<RC>-Stammdaten.xlsx` (Sheet `EEG Stammdaten`, Spalten wie die Upstream-Vorlage, Status ACTIVATED) und `<RC>-Energiedaten.xlsx` (EDA-Report-Format, Sheet `Energiedaten`, 96 Slots je Tag in Ortszeit, Format aus `excel/ExcelSourceNew.go` des energystore abgeleitet): Haushalts-, Wärmepumpen- und Gewerbeprofile, PV nach Sonnenstand für das Salzkammergut mit Tageswetter, dynamische Zuteilung mit exakten EEG-Identitäten, Späteinsteiger per `begin`. Deterministisch. Lokal ausführen (braucht openpyxl, ca. 25 s je 20-Mitglieder-EEG und 2 Jahre), Dateien nach `server:.../data/` kopieren, dann `setup-eeg.sh` (Upload ca. 1 min). |
| `build-backend.sh` | Baut `vfeeg-backend:local` aus dem aktuellen master (das Registry-Image `latest` ist veraltet und beantwortet authentifizierte Anfragen mit leeren 200ern). |

## Neuinstallation von Null

```sh
ssh server
mkdir -p ~/Container/eegfaktura && cd ~/Container/eegfaktura
curl -sL https://github.com/eegfaktura/eegfaktura-docker-compose/archive/refs/heads/main.tar.gz | tar xz --strip-components=1
# Dateien aus deploy/eegfaktura-local/ hierher kopieren (scp, inkl. eegs/), build-backend.sh nach build/,
# lokal erzeugte Import-Dateien (gen-eeg.py) nach data/
umask 077; printf "ADMIN_CLI_SECRET=%s\nAPI_SECRET=%s\nMANAGER_PW=%s\nIMPORTER_PW=%s\nDERKASSIER_PW=%s\nKC_ADMIN_PW=%s\nRC_NUMBER=TE100200\n" \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -base64 12 | tr -d '/+=')" "$(openssl rand -base64 12 | tr -d '/+=')" "$(openssl rand -base64 12 | tr -d '/+=')" "$(openssl rand -base64 18 | tr -d '/+=')" > secrets.env
ln -sfn secrets.env .env
set -a; . ./secrets.env; set +a
cp -n keycloak/import/realm-export.json keycloak/import/realm-export.json.orig
python3 patch-realm.py keycloak/import/realm-export.json eegfaktura-test.stromkreis.net "$ADMIN_CLI_SECRET" "$API_SECRET" "$MANAGER_PW" "$IMPORTER_PW" "$RC_NUMBER"
sed -e "s/__API_SECRET__/$API_SECRET/" -e "s/__ADMIN_CLI_SECRET__/$ADMIN_CLI_SECRET/" keycloak.json.tmpl > keycloak/keycloak.json
build/build-backend.sh
# DNS-Records und Caddy-Block (siehe oben) muessen vorher stehen: Backend und energystore
# holen beim Start die OIDC-Discovery von https://auth.eegfaktura-test.stromkreis.net
docker compose up -d          # Keycloak importiert den Realm nur beim ersten Start (leere DB)
docker compose ps             # warten bis alle 10 Dienste "Up", Keycloak "healthy"
./setup-eeg.sh                      # TE100200 (Musterdateien)
./setup-eeg.sh eegs/TE100300.json   # weitere Dummy-EEGs, Dateien vorher mit gen-eeg.py erzeugen
./setup-eeg.sh eegs/TE100400.json
./set-addresses.py eegs/TE100300.json --apply   # echte Adressen aus dem Ort in EEG-Faktura setzen
```

`docker compose down -v` löscht alle Daten (Postgres, Keycloak, energystore); danach `up -d` und `setup-eeg.sh` erneut. Änderungen an `keycloak/keycloak.json` (Docker-Secret) brauchen `down`/`up`, kein `restart`.

## Stromkreis anbinden

```sql
insert into eegfaktura_source (tenant_id, rc_number, community_id, base_url, auth_mode)
select id, 'TE100200', 'AT00999900000TC100200000000000002', 'https://eegfaktura-test.stromkreis.net', 'basic'
from tenant where slug = 'testeeg';
```

```sh
export EEGFAKTURA_TESTEEG_USER=importer EEGFAKTURA_TESTEEG_PASSWORD=<IMPORTER_PW aus secrets.env>
cd pipeline
.venv/bin/python -m stromkreis_pipeline eegfaktura-probe --tenant testeeg
.venv/bin/python -m stromkreis_pipeline eegfaktura-sync --tenant testeeg --full
```

## Was nicht läuft und warum

- **eda** (Marktkommunikation): braucht PONTON/KEP beim Netzbetreiber, ohne Anbindung nutzlos.
- **billing, postfix**: Abrechnung und Mailversand sind außerhalb des Stromkreis-Scopes.
- Der registrierte EEG-Admin-Benutzer hat ein temporäres Passwort (Upstream-Verhalten), beim ersten SPA-Login ist es zu ändern. Für den Importer gilt deshalb der separate Benutzer `importer` mit festem Passwort.
