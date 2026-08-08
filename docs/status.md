# Stand: 8. August 2026

Arbeitsstand zum Weiterarbeiten (z.B. am MacBook).

## Entscheidungen

- **Salzkammerstrom ist Demo-Mandant, ISCHLSTROM erster echter Test-Mandant (8.8.).** Der Dummy Salzkammerstrom (Standort Bad Ischl, per Migration angelegt) bekommt erfundene, generierte Daten und dient zum Entwickeln und Vorführen; er braucht keinen EEG-Faktura-Zugang. ISCHLSTROM wird als Mandant angelegt, sobald der Importer steht, und testet die echte Kette mit echten EEG-Faktura-Daten (Zugangsdaten nur in der Server-`.env`). Die eigene ISCHLSTROM-Infrastruktur läuft parallel weiter; ein vollständiger Umzug bleibt eine spätere Option.
- **Migrationswerkzeug: dbmate.** Reines SQL unter `platform/db/migrations/`, das generierte `platform/db/schema.sql` ist eingecheckt und der Vertrag für die Pipeline. Referenzen zwischen Fachtabellen als zusammengesetzte Fremdschlüssel über `(tenant_id, id)`, damit mandantenübergreifende Verweise auf DB-Ebene scheitern.
- **Rollen:** `member` (Mitglied), `board` (Vorstand), `operator` (Betreiber). Jeder Mandant hat mindestens einen Betreiber-Login; das sichert der Onboarding-Ablauf, kein DB-Constraint. Betreiber brauchen eine E-Mail (Check-Constraint).
- **Login ohne SMTP:** Einmal-Login-Links (7 Tage, nur SHA-256-Hash gespeichert) werden per Admin-CLI erzeugt und manuell übergeben; sie werden gegen eine Session (30 Tage, HttpOnly-Cookie) eingetauscht. Der spätere E-Mail-Magic-Link nutzt denselben Token-Fluss, es fehlt nur der Versand.
- **Betreiber-Login mit EEGFaktura-Konto: später, nicht jetzt (8.8.).** Wunschziel ist "Anmelden mit EEGFaktura" per OIDC gegen deren Keycloak (login.eegfaktura.at, Realm `EEGFaktura`). Geprüft: deren bestehender Client `at.ourproject.vfeeg.app` erlaubt weder Password Grant noch fremde Redirect-URIs; SSO braucht daher einen vom VFEEG-Team registrierten eigenen Client. Ein Anfrage-Entwurf liegt unter `docs/drafts/eegfaktura-sso-anfrage.md` (gitignored, noch nicht versendet). Bis dahin bleibt der Magic-Link-Fluss der Betreiber-Login; die Entwicklung hängt an nichts davon ab. OIDC mündet später in denselben Session-Fluss (Identität per E-Mail/`sub` auf eine `member`-Zeile mappen, dann `createSession`).

## Was läuft (produktiv erreichbar)

- **https://stromkreis.net**: deutsche Landingpage, `/anmelden/<token>`, geschützter Bereich `/intern`, Abmelden. DNS zeigt auf die Heim-IP, Caddy am Server terminiert TLS (`~/Container/caddy/Caddyfile`, Backup `Caddyfile.bak-stromkreis`).
- **Server-Stack** auf Host `server` unter `/home/martin/Container/stromkreis/`: `docker-compose.yml` (aus `deploy/` synchronisiert), `.env` (nur am Server: `POSTGRES_PASSWORD`, `PUBLIC_ORIGIN=https://stromkreis.net`), `src/` (rsync-Kopie des Repos), `data/postgres/`. Dienste: Postgres 17 (nur intern), Plattform auf 127.0.0.1:4000, dbmate-Migrate als One-Shot.
- **Angewendete Migrationen** (lokal getestet und am Server eingespielt): `initial_schema` (tenant, member, measurement_point), `seed_salzkammerstrom`, `operator_role`, `auth` (login_token, session), `energy_series_weather` (8.8.: `meter_code` mit stabilem `kind`-Schlüssel total_consumption/production_share/self_use/total_production/overshoot, `measurement` als 15-Minuten-Reihen je Zählpunkt und Kategorie in kWh mit UTC-Intervallbeginn und zusammengesetztem PK, `weather` als Stundenwetter je Mandant mit Spaltensatz der ISCHLSTROM-Loader), `battery_site` (8.8.: openHABian-Anlagen mit Wechselrichterprofil, Token-Hash, `last_seen_at`, letztem Status-Push als jsonb). Zusammengesetzte FKs und Checks per Smoke-Test verifiziert; `schema.sql` per Container-`pg_dump` aktualisiert.
- **Dashboard unter `/intern`** (8.8.): zuerst Anlagen-Karten je openHABian-Gateway (Betreiber sollen sofort sehen, dass alles läuft: Online/Offline ab 10 min ohne Push, SoC-Balken, PV/Batterie/Netz-Leistung mit Fronius-Vorzeichen, Versionen, Ladesperre-Hinweis), darunter KPI-Karten für den letzten vollständigen Tag (Verbrauch, Erzeugung, Eigendeckung, Autarkie) und das 14-Tage-Balkendiagramm (reines SVG, Erzeugung gestapelt als Eigendeckung + Überschuss). Queries durchgehend mandantengefiltert.
- **Demo-Daten für Salzkammerstrom** sind am Server eingespielt: `platform/scripts/demo-data.js seed [slug]` (deterministischer Seed, ersetzt Demo-Daten vollständig, Betreiber- und Vorstandskonten bleiben). Erzeugt 10 Mitglieder, 15 Zählpunkte, 35 Tage 15-Minuten-Reihen mit eingehaltenen EEG-Identitäten (Anteil = Gesamte Erzeugung; Eigendeckung + Überschuss = Anteil; Zuordnung proportional zum Verbrauch), Stundenwetter passend zur Tagesbewölkung und 3 Anlagen (2 online, 1 offline); druckt die Gateway-Tokens.
- **Betreiber-Account** Martin Aigner <martin@maigner.net> bei Salzkammerstrom existiert. Ein Einmal-Login-Link wurde am 7.8. erzeugt (gültig bis 14.8., falls noch nicht verwendet); neuer Link jederzeit per `invite` (siehe unten).

## Server-Verwaltung

```sh
ssh server   # geht von Workstation und MacBook (Key-only)
cd /home/martin/Container/stromkreis
docker compose exec platform node scripts/admin.js tenant:list
docker compose exec platform node scripts/admin.js tenant:create <slug> <name> <breite> <laenge>
docker compose exec platform node scripts/admin.js operator:create <tenant-slug> <name> <email>
docker compose exec platform node scripts/admin.js invite <tenant-slug> <email>
docker compose exec platform node scripts/demo-data.js seed [tenant-slug]   # Demo-Daten neu erzeugen
```

Sicherheit: Port 22 ist am Router offen; sshd erlaubt nur Public-Key-Login (`/etc/ssh/sshd_config.d/60-hardening.conf`), fail2ban ist aktiv (`/etc/fail2ban/jail.local`: 5 Fehlversuche in 10 min ergeben 1 h Sperre, eskalierend bis 1 Woche; Heimnetz 192.168.178.0/24 nie). Vorlagen der beiden Dateien liegen in `server:~/staging/`.

## Deployment

`deploy/deploy.sh` von der Entwicklungsmaschine aus: rsync des Arbeitsstands nach `server:.../src/`, Image-Build am Server, Migrationen, `docker compose up -d`. Kein git im Spiel; funktioniert vom MacBook, sobald das Repo dort liegt.

## Lokale Entwicklung

- `platform/`: `npm install`, dann `npm run dev` bzw. `npm run build && npm run check`. Runtime-Dependency: `postgres` (postgres.js, lazy verbunden).
- Lokale DB für Tests: Wegwerf-Container, z.B. `docker run -d --rm --name pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17-alpine`, dann `DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54329/stromkreis_dev?sslmode=disable" npm run db:migrate`.
- `db/schema.sql` aktualisiert dbmate nur, wenn lokal `pg_dump` vorhanden ist (`postgresql-client`; am Mac `brew install libpq`). Sonst wie bisher per `pg_dump` im Container erzeugen (Schema-Dump plus `INSERT`-Zeilen von `schema_migrations`).

## Offene Punkte

1. **Heim-IP statisch oder dynamisch?** Ungeklärt. Bei dynamischer IP braucht stromkreis.net einen DynDNS-Mechanismus, sonst fallen Website und SSH-Zugang beim IP-Wechsel aus.
2. **SMTP-Anbieter** für Magic-Link-Versand ist nicht entschieden; bis dahin Links per Admin-CLI.
3. **Admin-CLI ist ungeschützt** gegenüber jedem mit Server-Shell; vor Onboarding externer EEGs überdenken.
4. **Nächster Roadmap-Schritt (Phase 1):** EEG-Faktura-Importer in `pipeline/` gegen echte ISCHLSTROM-Daten (Portierungsquellen siehe `architektur.md`, API-Erkenntnisse in `docs/eegfaktura-api.md`). Schema (`energy_series_weather`, `battery_site`) und Demo-Datengenerator sind seit 8.8. vorhanden.
5. **EEGFaktura-SSO-Anfrage** an das VFEEG-Team versenden, sobald Martin den Entwurf freigibt (`docs/drafts/eegfaktura-sso-anfrage.md`); dabei auch den API-Client fürs Importieren mit anfragen. API-Erkenntnisse (Endpunkte, Auth-Wege, Fallstricke) und Importer-Plan seit 8.8. in `docs/eegfaktura-api.md`; sofort testbar ist der Basic-Weg gegen den metadata-Endpunkt (Achtung: Millisekunden, nicht Sekunden).
6. Git macht Martin weiterhin manuell; die Änderungen vom 8.8. (dieser Stand, `.gitignore`, `CLAUDE.md`, `architektur.md`, `roadmap.md`, Migrationen `energy_series_weather` und `battery_site` samt `schema.sql`, `scripts/demo-data.js`, Dashboard `/intern`) sind noch nicht committet.
