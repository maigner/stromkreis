#!/usr/bin/env bash
# Testdeployment auf den Homelab-Server: Quelltext per rsync, Build am Server.
# Aufruf aus beliebigem Verzeichnis: deploy/deploy.sh
set -euo pipefail

HOST=server
DIR=/home/martin/Container/stromkreis
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Gateway-Paket bauen (platform/static/gateway/stromkreis-gateway.tgz):
# die Artefakte sind nicht eingecheckt und wandern mit dem rsync auf den
# Server, wo die Plattform sie unter /gateway/ ausliefert.
"$REPO/gateway/openhab/setup/build-dist.sh"

rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude .svelte-kit \
    --exclude build \
    --exclude '.env' \
    "$REPO/" "$HOST:$DIR/src/"

# Compose-Datei liegt direkt im Deploy-Verzeichnis (Konvention in ~/Container)
rsync -az "$REPO/deploy/docker-compose.yml" "$HOST:$DIR/docker-compose.yml"

ssh "$HOST" "set -euo pipefail
    cd $DIR
    test -f .env || { echo 'FEHLER: $DIR/.env fehlt (POSTGRES_PASSWORD, PUBLIC_ORIGIN)'; exit 1; }
    # Image-Ablage der Plattform (Container laeuft als uid 1000); data/ gehoert
    # root (Docker), daher Anlage notfalls ueber einen kurzlebigen Container
    test -d data/images || mkdir -p data/images 2>/dev/null \
        || docker run --rm -v $DIR/data:/d alpine sh -c 'mkdir -p /d/images && chown 1000:1000 /d/images'
    docker compose build platform worker
    docker compose run --rm migrate
    docker compose up -d
    docker compose ps"
