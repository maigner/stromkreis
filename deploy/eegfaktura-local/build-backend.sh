#!/usr/bin/env bash
# Baut das EEG-Faktura-Backend aus dem aktuellen master (Tarball, kein git) als
# Image vfeeg-backend:local. Grund: siehe compose.override.yaml (eegfaktura-backend).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf backend && mkdir backend
curl -sL https://github.com/eegfaktura/eegfaktura-backend/archive/refs/heads/master.tar.gz | tar xz --strip-components=1 -C backend
docker build -t vfeeg-backend:local backend
echo "vfeeg-backend:local gebaut; danach: docker compose up -d eegfaktura-backend"
