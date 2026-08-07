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
  .env                 # nur am Server: POSTGRES_PASSWORD, PUBLIC_ORIGIN
  src/                 # rsync-Kopie des Repos (Build-Kontext)
  data/postgres/       # Datenbank-Volume
```

Die Plattform lauscht auf `127.0.0.1:4000`, die Datenbank ist nicht veröffentlicht. Öffentlicher Zugang läuft über den Eintrag in `~/Container/caddy/Caddyfile` am Server:

```
https://stromkreis.net {
    reverse_proxy localhost:4000
}
```

`PUBLIC_ORIGIN=https://stromkreis.net` in der Server-`.env` muss dazu passen (SvelteKit-CSRF-Prüfung). Nach Caddyfile-Änderungen: `docker exec caddy-reverse-proxy caddy reload --config /etc/caddy/Caddyfile`.
