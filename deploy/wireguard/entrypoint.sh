#!/bin/sh
# ============================================================================
# WireGuard-Wartungsnetz: wg0 aufbauen und die Peers (Gateways) jede Minute
# mit der Plattform abgleichen. Die DB der Plattform ist die Registry
# (battery_site.wg_address/wg_public_key, Endpunkt
# /api/gateway/sync/wireguard-peers, Auth GATEWAY_SYNC_TOKEN).
#
# Schluesselpaar des Servers: liegt im Volume /keys (server.key/server.pub)
# und wird beim ersten Start erzeugt. Die Plattform liest server.pub ueber
# dasselbe Volume und gibt ihn den Gateways in der Provisionierungsantwort
# mit (WG_SERVER_PUBLIC_KEY).
#
# Sicherheitsmodell des Wartungsnetzes: Verbindungen gehen ausschliesslich
# vom Server zu den Gateways. Ein Gateway (kompromittierter Pi, gestohlene
# SD-Karte) darf ueber den Tunnel weder andere Gateways noch den
# Compose-Stack erreichen. Drei Schichten:
#   1. microsocks lauscht nur auf der Compose-Adresse (eth0), nie auf wg0;
#   2. ip_forward ist aus (compose: sysctls), kein Peer-zu-Peer-Routing;
#   3. iptables: auf wg0 kommen nur Antworten auf Verbindungen des Servers
#      herein, FORWARD ist komplett zu.
# ============================================================================
set -eu

SUBNET_PREFIX="${WG_SUBNET_PREFIX:-10.88.0}"
PLATFORM_URL="${PLATFORM_URL:-http://platform:3000}"
KEY_DIR="${KEY_DIR:-/keys}"
WG_IF=wg0

log() { echo "[wireguard] $(date '+%F %T') $*"; }

[ -n "${GATEWAY_SYNC_TOKEN:-}" ] || { log "FEHLER: GATEWAY_SYNC_TOKEN fehlt."; exit 1; }

# --- Schluesselpaar ----------------------------------------------------------
mkdir -p "$KEY_DIR"
if [ ! -s "$KEY_DIR/server.key" ]; then
  umask 077
  wg genkey > "$KEY_DIR/server.key"
  log "Server-Schluesselpaar erzeugt."
fi
wg pubkey < "$KEY_DIR/server.key" > "$KEY_DIR/server.pub"
chmod 644 "$KEY_DIR/server.pub"
log "Server-Public-Key: $(cat "$KEY_DIR/server.pub")"

# --- Interface ---------------------------------------------------------------
ip link del "$WG_IF" 2>/dev/null || true
ip link add "$WG_IF" type wireguard
wg set "$WG_IF" private-key "$KEY_DIR/server.key" listen-port 51820
ip addr add "${SUBNET_PREFIX}.1/24" dev "$WG_IF"
ip link set "$WG_IF" up
log "wg0 laeuft (${SUBNET_PREFIX}.1/24, UDP 51820)."

# --- Abschottung des Wartungsnetzes ------------------------------------------
# Kein Routing zwischen den Peers: die Compose-Datei setzt die sysctl
# (/proc/sys ist im Container read-only, der Versuch hier ist nur Rueckfall).
{ echo 0 > /proc/sys/net/ipv4/ip_forward; } 2>/dev/null || true
if [ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" != "0" ]; then
  log "FEHLER: ip_forward laesst sich nicht abschalten (compose: sysctls net.ipv4.ip_forward=0 fehlt?)."
  exit 1
fi
# Auf wg0 nur Antworten auf Verbindungen hereinlassen, die der Server selbst
# aufgebaut hat (SSH der Fernwartung); alles andere von den Gateways verwerfen.
if iptables -w -P FORWARD DROP \
  && iptables -w -F INPUT \
  && iptables -w -A INPUT -i "$WG_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT \
  && iptables -w -A INPUT -i "$WG_IF" -j DROP; then
  log "Firewall aktiv: wg0 nur Antworten, kein FORWARD."
else
  # Die Bindung von microsocks an eth0 (unten) schuetzt auch ohne diese
  # Regeln; trotzdem laut melden, damit es im Log auffaellt.
  log "WARNUNG: iptables-Regeln konnten nicht gesetzt werden (Kernelmodule am Host?)."
fi

# --- SOCKS-Durchgang fuer die Fernwartungs-Aktionen der Plattform -------------
# Das Wartungsnetz existiert nur in diesem Container; microsocks reicht der
# Plattform TCP-Verbindungen zu den Gateways durch (Anlagen-Detailseite,
# Tab Fernwartung). Gebunden ausschliesslich an die Adresse im Compose-Netz:
# auf 0.0.0.0 waere der Durchgang auch unter ${SUBNET_PREFIX}.1 fuer jedes
# Gateway erreichbar und damit ein unauthentifizierter Weg zu allen anderen
# Gateways und in den Stack (Befund S4 der Sicherheitspruefung 9/2026).
SOCKS_BIND="$(ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
case "$SOCKS_BIND" in
  "${SUBNET_PREFIX}".*|"") log "FEHLER: keine Compose-Adresse auf eth0 gefunden (SOCKS_BIND='$SOCKS_BIND')."; exit 1 ;;
esac
microsocks -i "$SOCKS_BIND" -p "${WG_SOCKS_PORT:-1080}" &
SOCKS_PID=$!
log "SOCKS-Durchgang laeuft auf ${SOCKS_BIND}:${WG_SOCKS_PORT:-1080} (nur Compose-Netz, nicht auf wg0)."

trap 'kill "$SOCKS_PID" 2>/dev/null || true; ip link del "$WG_IF" 2>/dev/null || true; exit 0' INT TERM

# --- Peer-Abgleich -----------------------------------------------------------
while :; do
  peers="$(curl -fsS -m 15 -H "Authorization: Bearer $GATEWAY_SYNC_TOKEN" \
    "$PLATFORM_URL/api/gateway/sync/wireguard-peers" 2>/dev/null || true)"
  if [ -n "$peers" ] && printf '%s' "$peers" | jq -e '.peers' >/dev/null 2>&1; then
    # Gewuenschte Peers: "pubkey<TAB>ip"
    wanted="$(printf '%s' "$peers" | jq -r '.peers[] | "\(.public_key)\t\(.address)"')"
    current="$(wg show "$WG_IF" peers || true)"

    # Fehlende oder geaenderte Peers setzen (wg set ist idempotent)
    printf '%s\n' "$wanted" | while IFS="$(printf '\t')" read -r pub ip; do
      [ -n "$pub" ] || continue
      wg set "$WG_IF" peer "$pub" allowed-ips "${ip}/32" persistent-keepalive 0 \
        || log "Peer $ip konnte nicht gesetzt werden."
    done

    # Peers entfernen, die die Plattform nicht mehr kennt (Anlage geloescht)
    printf '%s\n' "$current" | while read -r pub; do
      [ -n "$pub" ] || continue
      if ! printf '%s\n' "$wanted" | cut -f1 | grep -qxF "$pub"; then
        wg set "$WG_IF" peer "$pub" remove && log "Peer entfernt: $pub"
      fi
    done
  else
    log "Plattform nicht erreichbar oder Antwort unlesbar - naechster Versuch in 60 s."
  fi
  sleep 60 &
  wait $!
done
