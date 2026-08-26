# Testdeployment

Das Testdeployment läuft auf dem Homelab-Server `server` unter `/home/martin/Container/stromkreis` (Konvention: ein Compose-Verzeichnis je Anwendung in `~/Container`, Caddy als Reverse-Proxy mit Host-Netzwerk).

## Ablauf

```sh
deploy/deploy.sh
```

Das Skript synchronisiert den Quelltext per rsync nach `server:/home/martin/Container/stromkreis/src/`, baut das Plattform-Image am Server, führt die Migrationen aus (dbmate-Container) und startet den Stack.

## Aufbau am Server

```
/home/martin/Container/stromkreis/
  docker-compose.yml   # aus deploy/ synchronisiert
  .env                 # nur am Server: POSTGRES_PASSWORD, PUBLIC_ORIGIN, OIDC_ISSUER, OIDC_CLIENT_ID,
                       #   EEGFAKTURA_BASE_URL, TOKEN_SECRET (openssl rand -hex 32), WORKER_PACE_SECONDS
  src/                 # rsync-Kopie des Repos (Build-Kontext)
  data/postgres/       # Datenbank-Volume
```

Dienste: Postgres, Plattform, `worker` (Pipeline-Container, arbeitet die Import-Aufträge des EEGFaktura-Logins ab; `docker compose logs -f worker`), `demo-heartbeat`. Die Plattform lauscht auf `127.0.0.1:4000`, die Datenbank ist nicht veröffentlicht. Öffentlicher Zugang läuft über den Eintrag in `~/Container/caddy/Caddyfile` am Server:

```
https://stromkreis.net {
    reverse_proxy localhost:4000
}
```

`PUBLIC_ORIGIN=https://stromkreis.net` in der Server-`.env` muss dazu passen (SvelteKit-CSRF-Prüfung). Nach Caddyfile-Änderungen: `docker exec caddy-reverse-proxy caddy reload --config /etc/caddy/Caddyfile`.

## Mandanten und Betreiber verwalten

Provider-CLI am Server (im laufenden Plattform-Container):

```sh
cd /home/martin/Container/stromkreis
docker compose exec platform node scripts/admin.js tenant:list
docker compose exec platform node scripts/admin.js tenant:create <slug> <name> <breite> <laenge>
docker compose exec platform node scripts/admin.js operator:create <tenant-slug> <name> <email>
docker compose exec platform node scripts/admin.js invite <tenant-slug> <email>
```

`operator:create` und `invite` drucken einen Einmal-Login-Link (7 Tage gültig), der manuell an die Person übergeben wird. Betreiber mit EEGFaktura-Konto brauchen das nicht: "Anmelden mit EEGFaktura" auf der Startseite legt Mandant und Betreiber-Konto beim ersten Login an (Keycloak-Client `net.stromkreis.platform`, siehe `eegfaktura-local/kc-client.sh` und `docs/status.md`).
