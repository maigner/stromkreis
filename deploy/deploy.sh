#!/usr/bin/env bash
# Testdeployment auf den Homelab-Server: Quelltext per rsync, Build am Server.
# Aufruf aus beliebigem Verzeichnis: deploy/deploy.sh
set -euo pipefail

HOST=server
DIR=/home/martin/Container/stromkreis
REPO="$(cd "$(dirname "$0")/.." && pwd)"

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
    docker compose build platform
    docker compose run --rm migrate
    docker compose up -d
    docker compose ps"
