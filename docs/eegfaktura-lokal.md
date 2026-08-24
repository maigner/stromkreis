# EEG-Faktura-Testinstanz auf `server`

Stand 24.8.2026. Eine vollständige EEG-Faktura-Installation läuft auf dem Homelab-Host `server` (`/home/martin/Container/eegfaktura/`) als Testgegenstelle für den Stromkreis-Importer und später das SSO-Login. Damit hängt die Entwicklung nicht mehr an der Antwort des VFEEG-Teams oder an Zugangsdaten zur SaaS-Instanz. Betriebsanleitung (URLs, Neuinstallation, Dateien): `deploy/eegfaktura-local/README.md`. Dieses Dokument hält fest, was gebaut wurde, was dabei herauskam und was es für den Importer bedeutet.

Quellen: github.com/eegfaktura (`eegfaktura-docker-compose`, `eegfaktura-keycloak`, `eegfaktura-energystore`, `eegfaktura-backend`, `eegfaktura-admin-backend`, `eegfaktura-admin`, `eegfaktura-web`, `eegfaktura-docs`), Stand 24.8.2026.

## 1. Aufbau

Basis ist der offizielle Entwicklungsstack `eegfaktura-docker-compose` (fertige Images von `ghcr.io/eegfaktura/*`, als Tarball ohne git). Darüber liegt `compose.override.yaml` aus `deploy/eegfaktura-local/`, das Compose automatisch mitlädt; der Upstream-Stack bleibt unverändert und aktualisierbar.

| Dienst | Rolle | Status |
|---|---|---|
| eegfaktura-keycloak | Keycloak 26, Realm `EEGFaktura` | läuft, Port 8180 |
| eegfaktura-postgresql, -mosquitto | DB (Stammdaten + Keycloak), MQTT | läuft |
| eegfaktura-backend | Go, Stammdaten, `GET /api/master/masterdata` (ProtectApi) | läuft, **aus master gebaut** (siehe 2.4) |
| eegfaktura-energystore | Go/Badger, `POST /energystore/query/rawdata` und `/query/{ecid}/metadata` (ProtectApi), Excel-Import per GraphQL | läuft |
| eegfaktura-web, -admin-web, -admin-backend, -filestore, -proxy | SPA (8001), Admin-Portal (8002), Registrierung, Dokumente, Caddy | läuft |
| eegfaktura-eda, -billing, -postfix | Marktkommunikation, Abrechnung, Mail | bewusst aus (Profil `full`) |

Der Caddy-Proxy bildet exakt die Pfade der SaaS-Instanz ab (`/api/*`, `/energystore/*`). Der Importer braucht nur `base_url = https://eegfaktura-test.stromkreis.net`, sonst nichts.

**Öffentliche Hostnamen mit TLS (seit 24.8. abends).** Token-Issuer (`iss`) und JWKS-URL müssen für Browser und Container gleich sein. Die Instanz hängt hinter dem Server-Caddy unter `https://eegfaktura-test.stromkreis.net` (SPA, `/api`, `/energystore`), `https://admin.eegfaktura-test.stromkreis.net` (Admin-Portal) und `https://auth.eegfaktura-test.stromkreis.net` (Keycloak, `KC_HOSTNAME` mit `KC_PROXY_HEADERS xforwarded`); A-Records in Route 53 auf die Heim-IP, Let's-Encrypt-Zertifikate von Caddy. Die Container erreichen die Hostnamen per `extra_hosts: host-gateway` (Caddy lauscht im Host-Netz auf 443), die EEG-Faktura-Ports 8001/8002/8180 sind nur an 127.0.0.1 gebunden (8080 ist durch Nextcloud AIO belegt, daher 8180). Die Keycloak-Konsole (`/admin/*`, `/realms/master/*`) lässt Caddy nur aus dem Heimnetz, dem Docker-Netz 172.16.0.0/12 und von der eigenen WAN-IP 85.127.8.140 (NAT-Hairpin der Heimnetz-Clients) durch (das Admin-Backend legt EEG-Benutzer über dieselbe Admin-API an, sonst 403 bei der Registrierung); das Bootstrap-Admin-Passwort kommt aus `secrets.env` statt des Upstream-Defaults. Der erste Versuch mit `http://server.fritz.box:8180` als Unified Hostname scheiterte im Browser (vermutlich HTTPS-Erzwingung oder Browser-DNS ohne fritz.box), obwohl curl alles erreichte; die öffentlichen HTTPS-Namen räumen beides aus.

**Daten.** Der Realm wird beim ersten Start aus `keycloak/import/realm-export.json` importiert, vorher gepatcht durch `patch-realm.py` (Abschnitt 2). `setup-eeg.sh` registriert per Admin-Backend-API die Test-EEG `TE100200` (Gemeinschafts-ID `AT00999900000TC100200000000000002`), lädt die Muster-Stammdaten (7 Teilnehmer, 11 Zählpunkte) und den Muster-Energiereport (1.1.2023 bis 20.5.2023, 7 Zählpunkte mit Daten) hoch und macht den ProtectApi-Smoke-Test. Der komplette Aufbau von Null (`docker compose down -v`, `up -d`, `setup-eeg.sh`) ist reproduzierbar durchgelaufen.

## 2. Befunde (jeder hat Zeit gekostet)

### 2.1 Der Realm-Export des Compose-Repos ist unvollständig

- **Client `at.ourproject.vfeeg.api` fehlt.** Über diesen Client tauschen Backend und energystore in `ProtectApi` (unser Basic-Auth-Weg) die Zugangsdaten serverseitig per Password Grant. Ohne ihn: 403 bei jedem Importer-Aufruf, die Dienste starten trotzdem. Die k8s-Realm-Definition in `eegfaktura-keycloak/realm/EEGFaktura.yaml` enthält ihn (confidential, Direct Access Grants an); der Compose-Export ist veraltet. `patch-realm.py` legt ihn an.
- **Gruppen-Mapper `access_groups` und `groups` fehlen**, obwohl `docs/architecture/auth.md` sie als Pflicht nennt. Backend (`AccessGroups.IsAdmin()` prüft auf `/EEG_ADMIN`) und energystore brauchen `access_groups` für jeden Bearer-Aufruf, also auch die SPA-Uploads. Ohne Mapper: 401. Der Patch ergänzt beide Mapper auf app-, api- und admin-Client.
- **`tenant`-Claim.** Das Attribut wird als JSON-String `["TE100200"]` gespeichert (so legt es das Admin-Backend an), der Mapper `jsonType.label = JSON` macht daraus das Array, das die Go-Dienste als `[]string` erwarten. Nicht `multivalued` setzen. Tenant ist die **RC-Nummer**, nicht die Gemeinschafts-ID.
- **Realm-Attribut `frontendUrl`** steht im Export auf `http://eegfaktura-keycloak:8080` und überstimmt `KC_HOSTNAME`. Folge: Backend und energystore brechen beim Start mit Issuer-Mismatch ab. Der Patch setzt es auf den Unified Hostname.
- Der Patch legt außerdem die Benutzer `manager` (Realm-Rolle Manager, Admin-Portal) und `importer` (Gruppe EEG_ADMIN, `tenant ["TE100200"]`, festes Passwort) an und setzt ein festes `admin-cli`-Secret. Damit entfallen die Klick-Schritte 3 bis 5 der Upstream-README.

### 2.2 Admin-Backend liest das admin-cli-Secret aus einer Env-Variable

`KEYCLOAK_CONFIG_JSON` ist in dessen `application.conf` auskommentiert; gelesen wird `KEYCLOAK_ADMIN_CLI_SECRET`, sonst gilt ein eingebautes Default-Secret. Ohne die Variable legt das Backend die EEG an, das Anlegen des Keycloak-Benutzers scheitert aber mit 401 (`invalid_client_credentials`). Das ist das offene Upstream-Issue #27 (12.7.2026). Das Override reicht das Secret aus `.env` (Symlink auf `secrets.env`) durch.

### 2.3 Keycloak-26-Details

- `/health/ready` liegt auf dem Management-Port (9181), nicht auf dem HTTP-Port; der Upstream-Healthcheck fragt den HTTP-Port und bleibt "unhealthy", womit alle abhängigen Dienste nie starten.
- `keycloak.json` wird als Docker-Secret beim Erzeugen der Container kopiert: nach Änderungen `down`/`up`, nicht `restart`.

### 2.4 Das Backend-Image der Registry ist veraltet

`ghcr.io/eegfaktura/vfeeg-backend:latest` stammt vom 30.5.2026, der Quellcode hat seither die Stammdaten-Import-Fixes (#34 bis #36) bekommen. Schlimmer: das alte Image beantwortet jede authentifizierte Anfrage (`GET /eeg`, Stammdaten-Upload) mit 200 ohne Body und ohne Wirkung, während Fehlerfälle (falscher Tenant, ungültiges Token) korrekt 401/403 liefern. Neuere Tags gibt es weder unter `eegfaktura` noch unter `vfeeg-development`. Deshalb wird das Backend aus dem aktuellen master gebaut (`build/build-backend.sh`, Multi-Stage-Dockerfile mit protoc, ca. 2 min am Server); damit funktioniert alles wie im Quellcode beschrieben.

### 2.5 energystore: `master-server`-Env wirkungslos

Der Compose-Stack setzt `ENERGYSTORE_SERVICES_master-server` kleingeschrieben; viper sucht `ENERGYSTORE_SERVICES_MASTER-SERVER` und fällt auf `localhost:9092` zurück. Folge: `rawdata` ohne `cps` scheitert mit "error fetch Meteringpoints" (der energystore holt die aktiven Zählpunkte per gRPC vom Backend). Im Override korrigiert.

### 2.6 Für den Importer entscheidend

1. **`ecId` ist die Gemeinschafts-ID**, nicht die RC-Nummer. Der energystore speichert je `<tenant>/<ecId>` (Verzeichnis `te100200/AT00999900000TC100200000000000002`); `/query/{ecid}/metadata` und `rawdata.ecId` mit der RC-Nummer liefern ein leeres `{}` bzw. legen einen leeren Store an. `X-Tenant` bleibt die RC-Nummer. Deshalb neue Spalte `eegfaktura_source.community_id` (Migration `eegfaktura_community_id`), Client-Parameter `ec_id`. Für ISCHLSTROM ist die Gemeinschafts-ID aus den Stammdaten (`communityId` in `/api/master/masterdata` ist nicht enthalten, sie steht in der EEG-Stammdatenansicht der SPA) einzutragen.
2. **Basic-Auth-Kodierung** ist je Dienst verschieden: energystore dekodiert URL-safe Base64, das Backend (`/api/master/masterdata`) Standard-Base64. Der Client kodiert jetzt je Pfad.
3. **`/api/master/masterdata`** liefert `firstname`/`lastname`/`meters` (nicht `firstName`/`lastName`/`meteringPoint`); `normalize_masterdata` akzeptiert beide Formen. Ohne diesen Fix kamen die Zählpunkte nur aus den Rohdaten (nur die aktiven Verbraucher, ohne Namen).
4. **Sommerzeit:** energystore v1 liefert am Umstellungstag (26.3.2023) 96 statt 92 Slots; die vier nicht existierenden Ortszeit-Slots 02:00 bis 02:45 fallen auf dieselben UTC-Zeitpunkte wie 03:00 bis 03:45. `normalize_rawdata` verwirft Duplikate (letzter Wert gilt) mit Warnung; vorher scheiterte der Upsert (`ON CONFLICT` trifft eine Zeile zweimal).
5. **`ProtectApi` akzeptiert nur Basic.** Ein Bearer-Token wird mit 400 abgewiesen. Der Token-Weg (`client_credentials`) aus der Gitbook-Doku trifft nur die `Protect`-Routen der SPA und braucht dort `access_groups` mit `/EEG_ADMIN` sowie den `tenant`-Claim. Bis zur Antwort des VFEEG-Teams ist Basic der einzige aus dem Quellcode belegbare Weg; ob er auf eegfaktura.at funktioniert, hängt allein davon ab, ob deren `api`-Client Direct Access Grants erlaubt (laut deren k8s-YAML ja).

## 3. Ergebnis des Ende-zu-Ende-Tests (24.8.)

Lokale Stromkreis-DB (Wegwerf-Postgres in Colima, Mandant `testeeg`, `eegfaktura_source` mit `community_id` und `base_url https://eegfaktura-test.stromkreis.net`, `auth_mode basic`, Benutzer `importer`):

- `eegfaktura-probe`: "Zugang ok, Daten von 2022-12-31 bis 2023-05-20 (basic)".
- `eegfaktura-sync --full`: 278.240 Zeilen in 5 Monats-Chunks, 11 Zählpunkte mit Teilnehmernamen aus den Stammdaten (7 davon mit Daten: 6 Verbrauch, 1 Erzeugung; die 4 Erzeugungs-Zählpunkte `AT000...` der Muster-Stammdaten kommen im Muster-Energiereport nicht vor), alle fünf Kategorien (`total_consumption`, `production_share`, `self_use`, `total_production`, `overshoot`), `quality` aus `qov`, 48 Sommerzeit-Duplikate verworfen.
- Die EEG-Identitäten (Anteil = Eigendeckung + Überschuss) gehen bei den Musterdaten nicht auf; die Musterdatei ist synthetisch. Der echte Diff-Test (Phase C in `docs/eegfaktura-api.md`) braucht einen ISCHLSTROM-Export, der sich in der Testinstanz genauso hochladen lässt (`setup-eeg.sh`, Schritt 5, Sheet `Energiedaten`).

## 4. Offen

- **SSO lokal:** Client `net.stromkreis.platform` (public, Authorization Code + PKCE, Redirect `http://localhost:5173/auth/eegfaktura/callback`, Mapper wie am app-Client) in `patch-realm.py` ergänzen, sobald der OIDC-Login gebaut wird. Issuer: `https://auth.eegfaktura-test.stromkreis.net/realms/EEGFaktura`.
- **Client-Credentials-Weg** lokal testen (Client `net.stromkreis.import`, Service Account mit `tenant`-Attribut) sobald klar ist, gegen welche Routen die SaaS-Instanz ihn freischaltet.
- Der Muster-Energiereport heißt `..._TE100100.xlsx`, die EEG `TE100200`; der energystore übernimmt die Gemeinschafts-ID aus dem Upload-Aufruf, nicht aus der Datei, deshalb stört das nicht.
- Upstream melden (Compose-Repo): fehlender `api`-Client und Gruppen-Mapper im Realm-Export, Healthcheck-Port, `master-server`-Env, veraltetes Backend-Image, `KEYCLOAK_ADMIN_CLI_SECRET` (Issue #27).
