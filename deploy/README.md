# Testdeployment

Das Testdeployment läuft auf dem Homelab-Server `server` unter `/home/martin/Container/stromkreis` (Konvention: ein Compose-Verzeichnis je Anwendung in `~/Container`, Caddy als Reverse-Proxy mit Host-Netzwerk).

## Ablauf

```sh
deploy/deploy.sh
```

Das Skript packt zuerst das Gateway-Paket (`gateway/openhab/setup/build-dist.sh` nach `platform/static/gateway/`), synchronisiert den Quelltext per rsync nach `server:/home/martin/Container/stromkreis/src/`, baut die Images für Plattform, Worker und WireGuard am Server, führt die Migrationen aus (dbmate-Container) und startet den Stack.

Vorher prüfen, ob gerade ein SD-Karten-Image gebaut wird (`ls data/images/ | grep work` am Server): der Neustart des Plattform-Containers bricht einen laufenden Bau ab.

## Aufbau am Server

```
/home/martin/Container/stromkreis/
  docker-compose.yml   # aus deploy/ synchronisiert
  .env                 # nur am Server: POSTGRES_PASSWORD, PUBLIC_ORIGIN, OIDC_ISSUER, OIDC_CLIENT_ID,
                       #   EEGFAKTURA_BASE_URL, TOKEN_SECRET, WORKER_PACE_SECONDS,
                       #   GATEWAY_SYNC_TOKEN, EXPRESS_KEY (je openssl rand -hex 32),
                       #   WG_ENDPOINT, CLOUD_BASE_URL, CLOUD_DOMAIN, CLOUD_PROXY_HOST
  src/                 # rsync-Kopie des Repos (Build-Kontext)
  data/postgres/       # Datenbank-Volume
  data/images/         # SD-Karten-Images der Anlagen (gehört uid 1000)
  data/mongo/          # Datenbank der openHAB-Cloud
  data/redis/          # Sitzungs-Store der openHAB-Cloud
```

Dazu das benannte Volume `wg-keys`: das WireGuard-Schlüsselpaar des Servers, erzeugt der WireGuard-Container beim ersten Start; die Plattform liest daraus `server.pub` (read-only). Nicht löschen, sonst verlieren alle Gateways ihren Tunnel.

Dienste:

- `db` (Postgres), `platform` (lauscht auf `127.0.0.1:4000`), `worker` (Pipeline-Container, arbeitet die Import-Aufträge des EEGFaktura-Logins ab; `docker compose logs -f worker`), `demo-heartbeat`.
- `wireguard`: Wartungsnetz `10.88.0.0/24` für die Gateways (UDP 51820 veröffentlicht, braucht eine Weiterleitung am Router), Peer-Abgleich minütlich aus der Plattform-DB, dazu der stack-interne SOCKS-Durchgang für die SSH-Konsole der Anlagen-Detailseite. SSH vom Terminal: `deploy/wg-ssh.sh <tunnel-ip>`.
- `cloud-app` (Stromkreis-eigene openHAB-Cloud, lauscht auf `127.0.0.1:4100`), `cloud-mongodb`, `cloud-redis`, `cloud-sync` (legt die Cloud-Konten der Anlagen automatisch an).

Die Datenbanken sind nicht veröffentlicht. Öffentlicher Zugang läuft über drei Einträge in `~/Container/caddy/Caddyfile` am Server (die DNS-A-Records für `hac` und `remote.hac` müssen auf den Server zeigen, sonst bekommt Caddy keine Zertifikate):

```
https://stromkreis.net {
    reverse_proxy localhost:4000
}
https://hac.stromkreis.net {
    reverse_proxy localhost:4100
}
https://remote.hac.stromkreis.net {
    reverse_proxy localhost:4100
}
```

`PUBLIC_ORIGIN=https://stromkreis.net` in der Server-`.env` muss dazu passen (SvelteKit-CSRF-Prüfung), ebenso `CLOUD_BASE_URL`/`CLOUD_DOMAIN` (`hac.stromkreis.net`) und `CLOUD_PROXY_HOST` (`remote.hac.stromkreis.net`). Nach Caddyfile-Änderungen: `docker exec caddy-reverse-proxy caddy reload --config /etc/caddy/Caddyfile`.

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
