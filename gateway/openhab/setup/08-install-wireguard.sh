#!/usr/bin/env bash
# ============================================================================
# 08 - WireGuard-Fernwartung
#
# Baut einen dauerhaften, ausgehenden WireGuard-Tunnel vom Pi zum
# Wartungsnetz der Plattform auf. Damit bleibt die Anlage fuer Updates und
# Fehlersuche per SSH erreichbar, ohne dass am Router des Mitglieds etwas
# geoeffnet wird (PersistentKeepalive haelt das NAT-Mapping offen; durch
# den Tunnel laeuft ausschliesslich das Wartungsnetz /24, nicht der
# Internetverkehr des Mitglieds).
#
# Braucht in gateway.conf (kommt alles von der Plattform): INSTALL_WIREGUARD=1,
# WG_ADDRESS (eindeutige Tunnel-IP der Anlage), WG_SERVER_ENDPOINT
# (Host:Port) und WG_SERVER_PUBLIC_KEY. Der Pi erzeugt sein Schluesselpaar
# selbst und meldet den Public-Key an die Plattform; der WireGuard-Container
# am Server traegt den Peer innerhalb einer Minute ein.
#
# Die SSH-Anmeldung durch den Tunnel laeuft per Passwort des Benutzers
# openhabian (das Passwort der Anlage steht auf der Anlagen-Detailseite).
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_config

WG_IF="wg0"
WG_DIR="/etc/wireguard"
WG_KEY="$WG_DIR/stromkreis-pi.key"
WG_PUB="$WG_DIR/stromkreis-pi.pub"
WG_CONF="$WG_DIR/$WG_IF.conf"

if [ "$INSTALL_WIREGUARD" != "1" ]; then
  log "WireGuard-Fernwartung nicht gewuenscht (INSTALL_WIREGUARD=0) - uebersprungen."
  exit 0
fi

[ -n "$WG_ADDRESS" ] || die "WG_ADDRESS fehlt in gateway.conf (eindeutige Tunnel-IP der Anlage, z. B. 10.88.0.11)."
echo "$WG_ADDRESS" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' \
  || die "WG_ADDRESS ist keine IPv4-Adresse: $WG_ADDRESS"
case "$WG_SERVER_ENDPOINT" in
  *:*) : ;;
  *) die "WG_SERVER_ENDPOINT braucht Host:Port (z. B. stromkreis.net:51820): $WG_SERVER_ENDPOINT" ;;
esac
[ -n "$WG_SERVER_PUBLIC_KEY" ] || die "WG_SERVER_PUBLIC_KEY fehlt in gateway.conf."
[ "${#WG_SERVER_PUBLIC_KEY}" -eq 44 ] \
  || warn "Server-Public-Key hat unerwartete Laenge (${#WG_SERVER_PUBLIC_KEY} statt 44 Zeichen)."

# Nur das /24 rund um die Tunnel-IP wird durch den Tunnel geroutet -
# der normale Internetverkehr des Mitglieds bleibt unberuehrt.
WG_SUBNET="${WG_ADDRESS%.*}.0/24"

# --- WireGuard installieren -------------------------------------------------
if command -v wg >/dev/null 2>&1; then
  log "WireGuard ist bereits installiert."
else
  log "Installiere WireGuard (apt-get) ..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || warn "apt-get update fehlgeschlagen - Installation wird trotzdem versucht."
  apt-get install -y -qq wireguard || die "WireGuard konnte nicht installiert werden."
fi

# --- Schluesselpaar des Pi --------------------------------------------------
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"
if [ -s "$WG_KEY" ]; then
  log "Schluesselpaar vorhanden: $WG_KEY"
else
  (umask 077 && wg genkey > "$WG_KEY")
  log "Schluesselpaar erzeugt: $WG_KEY"
fi
(umask 077 && wg pubkey < "$WG_KEY" > "$WG_PUB")
PI_PUBLIC_KEY="$(cat "$WG_PUB")"

# --- wg0.conf ---------------------------------------------------------------
tmp="$(mktemp)"
cat > "$tmp" <<CONF
# Erzeugt von 08-install-wireguard.sh - Stromkreis Fernwartung.
# Aenderungen hier gehen beim naechsten Setup-Lauf verloren.
[Interface]
Address    = ${WG_ADDRESS}/32
PrivateKey = $(cat "$WG_KEY")

[Peer]
# Wartungsnetz der Plattform
PublicKey           = ${WG_SERVER_PUBLIC_KEY}
Endpoint            = ${WG_SERVER_ENDPOINT}
AllowedIPs          = ${WG_SUBNET}
PersistentKeepalive = 25
CONF

changed=1
if [ -f "$WG_CONF" ] && cmp -s "$tmp" "$WG_CONF"; then
  changed=0
  log "unveraendert: $WG_CONF"
else
  if [ -f "$WG_CONF" ]; then
    cp -a "$WG_CONF" "$WG_CONF.bak-$(date +%Y%m%d%H%M%S)"
    log "Backup angelegt: $WG_CONF.bak-*"
  fi
  install -m 0600 "$tmp" "$WG_CONF"
  log "geschrieben: $WG_CONF"
fi
rm -f "$tmp"

# --- Dienst -----------------------------------------------------------------
systemctl enable "wg-quick@${WG_IF}" >/dev/null 2>&1 \
  || warn "Autostart konnte nicht aktiviert werden: systemctl enable wg-quick@${WG_IF}"
if systemctl is-active --quiet "wg-quick@${WG_IF}"; then
  if [ "$changed" = "1" ]; then
    systemctl restart "wg-quick@${WG_IF}" || die "wg-quick@${WG_IF} konnte nicht neu gestartet werden."
    log "Tunnel neu gestartet."
  else
    log "Tunnel laeuft bereits."
  fi
else
  systemctl start "wg-quick@${WG_IF}" || die "wg-quick@${WG_IF} konnte nicht gestartet werden."
  log "Tunnel gestartet."
fi

handshake_ok() {
  local ts
  ts="$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{print $2; exit}')"
  [ -n "$ts" ] && [ "$ts" -gt 0 ]
}

# Public-Key an die Plattform melden - der WireGuard-Container am Server
# traegt den Peer innerhalb einer Minute ein, dann steht der Tunnel.
if [ -n "$STROMKREIS_SITE_TOKEN" ]; then
  report_phase tunnel "Tunnel-IP ${WG_ADDRESS}, Public-Key gemeldet." "\"wg_public_key\":$(json_str "$PI_PUBLIC_KEY")"
  waited=0
  until handshake_ok || [ "$waited" -ge 180 ]; do sleep 10; waited=$((waited + 10)); done
fi

if handshake_ok; then
  log "Tunnel steht - Handshake mit dem Wartungsnetz erfolgt."
else
  warn "Noch kein Handshake. Der Peer wird am Server automatisch eingetragen;"
  warn "sonst Endpoint (${WG_SERVER_ENDPOINT}) und Router-Weiterleitung"
  warn "(UDP ${WG_SERVER_ENDPOINT##*:}) pruefen. Die Installation laeuft weiter."
fi

cat <<INFO
[Stromkreis]
[Stromkreis] Fernwartung: ssh openhabian@${WG_ADDRESS}
[Stromkreis] (vom Server aus: deploy/wg-ssh.sh ${WG_ADDRESS})
INFO
