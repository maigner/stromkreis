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
- **Angewendete Migrationen** (lokal getestet und am Server eingespielt): `initial_schema` (tenant, member, measurement_point), `seed_salzkammerstrom`, `operator_role`, `auth` (login_token, session).
- **Betreiber-Account** Martin Aigner <martin@maigner.net> bei Salzkammerstrom existiert. Ein Einmal-Login-Link wurde am 7.8. erzeugt (gültig bis 14.8., falls noch nicht verwendet); neuer Link jederzeit per `invite` (siehe unten).

## Server-Verwaltung

```sh
ssh server   # geht von Workstation und MacBook (Key-only)
cd /home/martin/Container/stromkreis
docker compose exec platform node scripts/admin.js tenant:list
docker compose exec platform node scripts/admin.js tenant:create <slug> <name> <breite> <laenge>
docker compose exec platform node scripts/admin.js operator:create <tenant-slug> <name> <email>
docker compose exec platform node scripts/admin.js invite <tenant-slug> <email>
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
4. **Nächster Roadmap-Schritt (Phase 1):** Schema für 15-Minuten-Reihen und Wetterdaten, Demo-Datengenerator für Salzkammerstrom, dann EEG-Faktura-Importer in `pipeline/` gegen echte ISCHLSTROM-Daten (Portierungsquellen siehe `architektur.md`).
5. **EEGFaktura-SSO-Anfrage** an das VFEEG-Team versenden, sobald Martin den Entwurf freigibt (`docs/drafts/eegfaktura-sso-anfrage.md`); dabei auch klären, ob die Energystore-API statt Basic Auth einen Token-Zugriff bietet.
6. Git macht Martin weiterhin manuell; die Änderungen vom 8.8. (dieser Stand, `.gitignore`, `CLAUDE.md`, `architektur.md`, `roadmap.md`) sind noch nicht committet.
