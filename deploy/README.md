# Testdeployment

Das Testdeployment läuft auf dem Homelab-Server `server` unter `/home/martin/Container/stromkreis` (Konvention: ein Compose-Verzeichnis je Anwendung in `~/Container`, Caddy als Reverse-Proxy mit Host-Netzwerk).

## Ablauf

```sh
deploy/deploy.sh
```

Das Skript packt zuerst das Gateway-Paket (`gateway/openhab/setup/build-dist.sh` nach `platform/static/gateway/`; signiert mit dem privaten Schlüssel `~/.config/stromkreis/package-signing.key`, der auf jedem Deploy-Rechner liegen und zum eingecheckten `platform/src/lib/server/stromkreis-gateway.pub` passen muss, sonst bricht der Build ab; siehe `docs/sicherheit.md`), synchronisiert den Quelltext per rsync nach `server:/home/martin/Container/stromkreis/src/`, baut die Images für Plattform, Worker und WireGuard am Server, führt die Migrationen aus (dbmate-Container) und startet den Stack.

Vorher prüfen, ob gerade ein SD-Karten-Image gebaut wird (`ls data/images/ | grep work` am Server): der Neustart des Plattform-Containers bricht einen laufenden Bau ab.

## Aufbau am Server

```
/home/martin/Container/stromkreis/
  docker-compose.yml   # aus deploy/ synchronisiert
  .env                 # nur am Server: POSTGRES_PASSWORD, PUBLIC_ORIGIN, OIDC_ISSUER, OIDC_CLIENT_ID,
                       #   EEGFAKTURA_BASE_URL, TOKEN_SECRET, WORKER_PACE_SECONDS,
                       #   GATEWAY_SYNC_TOKEN, EXPRESS_KEY, MONGO_PASSWORD, REDIS_PASSWORD
                       #   (je openssl rand -hex 32),
                       #   WG_ENDPOINT, CLOUD_BASE_URL, CLOUD_DOMAIN, CLOUD_PROXY_HOST,
                       #   REVIEW_CLOUD_USERNAME, REVIEW_CLOUD_PASSWORD, REVIEW_CLOUD_UUID,
                       #   REVIEW_CLOUD_SECRET (Demo-Anlage + Demo-openHAB der Seite /review)
  src/                 # rsync-Kopie des Repos (Build-Kontext)
  data/postgres/       # Datenbank-Volume
  data/images/         # SD-Karten-Images der Anlagen (gehört uid 1000)
  data/mongo/          # Datenbank der openHAB-Cloud
  data/redis/          # Sitzungs-Store der openHAB-Cloud
```

Dazu das benannte Volume `wg-keys`: das WireGuard-Schlüsselpaar des Servers, erzeugt der WireGuard-Container beim ersten Start; die Plattform liest daraus `server.pub` (read-only). Nicht löschen, sonst verlieren alle Gateways ihren Tunnel.

Dienste:

- `db` (Postgres), `platform` (lauscht auf `127.0.0.1:4000`), `worker` (Pipeline-Container, arbeitet die Import-Aufträge des EEGFaktura-Logins ab; `docker compose logs -f worker`), `demo-heartbeat`.
- `wireguard`: Wartungsnetz `10.88.0.0/24` für die Gateways (UDP 51820 veröffentlicht, braucht eine Weiterleitung am Router), Peer-Abgleich minütlich aus der Plattform-DB, dazu der SOCKS-Durchgang für die Fernwartungs-Aktionen der Anlagen-Detailseite (SSH). Verbindungen gehen nur vom Server zu den Gateways: der SOCKS-Durchgang lauscht ausschließlich auf der Compose-Adresse (nie auf `wg0`), `ip_forward` ist aus, und iptables lässt auf `wg0` nur Antworten herein. Ein Gateway erreicht über den Tunnel also weder andere Gateways noch den Stack. SSH vom Terminal: `deploy/wg-ssh.sh <tunnel-ip>`.
- `cloud-app` (Stromkreis-eigene openHAB-Cloud, lauscht auf `127.0.0.1:4100`), `cloud-mongodb` und `cloud-redis` (beide nur mit Anmeldung: Mongo-Konto `openhab` mit `MONGO_PASSWORD`, Redis mit `REDIS_PASSWORD`), `cloud-sync` (legt die Cloud-Konten der Anlagen automatisch an).
- `demo-openhab` (openHAB 4.3 ohne Wechselrichter fuer die App-Pruefung, Seite `/review`; haengt mit `REVIEW_CLOUD_UUID/SECRET` an der Cloud, Simulation und Seiten aus `deploy/demo-openhab/`, Daten unter `data/demo-openhab/`, kein Port nach aussen). Die zugehoerige Demo-Anlage legt `demo-heartbeat` beim Start an (`demo-data.js review`).

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

## Mongo-Anmeldung auf bestehenden Daten einschalten (einmalig)

Das Mongo-Image legt das Konto aus `MONGO_INITDB_ROOT_*` nur auf einem leeren `data/mongo/` an, schaltet `--auth` aber in jedem Fall ein. Auf einem Server mit bestehender Cloud-Datenbank darum **vor** dem Deploy, solange der alte Stack noch ohne Anmeldung läuft:

```sh
cd /home/martin/Container/stromkreis
printf 'MONGO_PASSWORD=%s\nREDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
. ./.env
docker compose exec cloud-mongodb mongosh --quiet admin \
  --eval "db.createUser({user:'openhab', pwd:'$MONGO_PASSWORD', roles:[{role:'root', db:'admin'}]})"
```

Danach normal `deploy/deploy.sh`; Compose startet `cloud-mongodb`, `cloud-redis`, `cloud-app` und `cloud-sync` mit Anmeldung neu (Redis braucht keinen Vorabschritt, `--requirepass` kommt aus der Kommandozeile). Prüfen:

```sh
docker compose ps                                  # cloud-mongodb und cloud-redis "healthy"
docker compose exec cloud-mongodb mongosh --quiet openhab --eval 'db.users.countDocuments()'   # muss "requires authentication" melden
docker compose logs --tail 20 cloud-app            # "Successfully connected to mongodb", "Redis is ready"
docker compose exec wireguard iptables -S          # INPUT: wg0 nur ESTABLISHED, dann DROP; FORWARD DROP
docker compose exec wireguard netstat -ltn         # 1080 nur auf der 172er-Adresse, nicht 0.0.0.0
```

Von einem Test-Pi aus muss `nc -zvw3 10.88.0.1 1080` scheitern und ein anderes Gateway (`nc -zvw3 10.88.0.<x> 22`) unerreichbar sein, während eine Fernwartungs-Abfrage ("Systemzustand") auf der Anlagen-Detailseite weiter funktioniert.

## Mandanten und Betreiber verwalten

Provider-CLI am Server (im laufenden Plattform-Container):

```sh
cd /home/martin/Container/stromkreis
docker compose exec platform node scripts/admin.js tenant:list
docker compose exec platform node scripts/admin.js tenant:create <slug> <name> <breite> <laenge>
docker compose exec platform node scripts/admin.js operator:create <tenant-slug> <name> <email>
docker compose exec platform node scripts/admin.js invite <tenant-slug> <email>
docker compose exec platform node scripts/admin.js secrets:encrypt
docker compose exec platform node scripts/admin.js site:password <anlagen-id>
```

`operator:create` und `invite` drucken einen Einmal-Login-Link (7 Tage gültig), der manuell an die Person übergeben wird. Rollen (`member.role`): `operator` darf im Betreiberbereich alles, `board` (Vorstand) sieht nur, `member` hat dort keinen Zugang (403). `secrets:encrypt` verschlüsselt Geheimnisse, die eine Migration im Klartext kopiert hat (läuft bei jedem Deploy automatisch, idempotent); `site:password` gibt das Linux-Passwort einer Anlage aus (nutzt `deploy/pi-ssh.sh`). Betreiber mit EEGFaktura-Konto brauchen das nicht: "Anmelden mit EEGFaktura" auf der Startseite legt Mandant und Betreiber-Konto beim ersten Login an (Keycloak-Client `net.stromkreis.platform`, siehe `eegfaktura-local/kc-client.sh` und `docs/status.md`).
