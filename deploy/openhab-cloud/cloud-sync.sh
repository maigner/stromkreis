#!/bin/sh
# Wrapper fuer den Konten-Sync: rendert config.json aus dem Template (wie
# run-app.sh des Cloud-Images - das passiert dort erst im CMD, das wir hier
# ersetzen) und laesst dann jede Minute eine Sync-Runde laufen.
set -e
cd /opt/openhabcloud
if [ -f config.json.template ]; then
  node -e "
    const fs = require('fs');
    const t = fs.readFileSync('config.json.template', 'utf8');
    const j = t.replace(/\\\$\{(\w+)(?::-(.*?))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
    JSON.parse(j);
    fs.writeFileSync('config.json', j);
  "
fi
# timeout als zweite Sicherung: selbst wenn eine Runde haengen bleibt
# (haengender fetch, offene Handles), blockiert sie die Schleife nie lange.
while true; do
  timeout 300 node /sync/cloud-sync.js || true
  sleep 60
done
