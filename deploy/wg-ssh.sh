#!/usr/bin/env bash
# SSH auf ein Gateway durch den WireGuard-Container am Server:
#   deploy/wg-ssh.sh 10.88.0.11
# Anmeldung als openhabian mit dem Anlagen-Passwort (Anlagen-Detailseite).
# Funktioniert von der Entwicklungsmaschine (via ssh server) und direkt am
# Server (dann ohne den ssh-Umweg).
set -euo pipefail
[ $# -ge 1 ] || { echo "Verwendung: $0 <tunnel-ip> [ssh-argumente]"; exit 1; }
ip="$1"; shift
if [ "$(hostname)" = "server" ]; then
  cd /home/martin/Container/stromkreis
  exec docker compose exec wireguard ssh -o StrictHostKeyChecking=accept-new "openhabian@$ip" "$@"
fi
exec ssh -t server "cd /home/martin/Container/stromkreis && docker compose exec wireguard ssh -o StrictHostKeyChecking=accept-new openhabian@$ip $*"
