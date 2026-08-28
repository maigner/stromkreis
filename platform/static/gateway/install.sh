#!/usr/bin/env bash
# ============================================================================
# Stromkreis Gateway - Einrichtung (Bootstrap)
#
# Wird von stromkreis-firstboot nach der openHABian-Erstinstallation geladen
# und ausgefuehrt (als root); manueller Aufruf fuer Sonderfaelle:
#   STROMKREIS_PROVISION_CODE=XXXX-XXXX bash install.sh
#
# Ablauf:
#   1. Einrichtungscode gegen die Konfiguration samt Anlagen-Token tauschen
#      (POST /api/gateway/provision/v1) und nach /etc/stromkreis/gateway.conf
#      schreiben (nur beim ersten Lauf; danach gilt der gespeicherte Token).
#   2. Gateway-Paket laden (/gateway/stromkreis-gateway.tgz), Pruefsumme
#      pruefen, nach /opt/stromkreis/openhab entpacken (bestehende
#      Installation wird gesichert) - auch der Weg fuer Updates.
#   3. Einrichtung starten: setup/install-gateway.sh (meldet jede Phase an
#      die Plattform; Exit 75 = unvollstaendig, stromkreis-firstboot bzw.
#      stromkreis-update wiederholen den Lauf automatisch).
# ============================================================================
set -uo pipefail

CONF=/etc/stromkreis/gateway.conf
DEST="${STROMKREIS_DEST:-/opt/stromkreis}"
LOG_PREFIX="[stromkreis-install]"

log() { echo "$LOG_PREFIX $*"; }
die() { log "FEHLER: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "bitte als root ausfuehren."
for cmd in curl tar sha256sum python3; do
  command -v "$cmd" >/dev/null || die "'$cmd' fehlt."
done

# Code und Plattform-URL: aus der Umgebung oder von der Boot-Partition
for f in /boot/firmware/stromkreis-provision.conf /boot/stromkreis-provision.conf; do
  # shellcheck disable=SC1090
  [ -f "$f" ] && . "$f"
done
BASE="${STROMKREIS_BASE_URL:-https://stromkreis.net}"

# --- 1. Konfiguration holen (einmalig) --------------------------------------
if [ ! -f "$CONF" ]; then
  code="${STROMKREIS_PROVISION_CODE:-}"
  [ -n "$code" ] || die "kein Einrichtungscode (STROMKREIS_PROVISION_CODE) gefunden."
  log "Tausche Einrichtungscode gegen die Konfiguration ($BASE) ..."
  response="$(curl -fsS -m 30 -H 'Content-Type: application/json' \
    -d "{\"code\":\"$code\"}" "$BASE/api/gateway/provision/v1")" \
    || die "Einrichtungscode ungueltig, abgelaufen oder Plattform nicht erreichbar."
  mkdir -p "$(dirname "$CONF")"
  printf '%s' "$response" | python3 -c '
import json, sys
config = json.load(sys.stdin)["config"]
print("# Stromkreis Gateway - Konfiguration (erzeugt von install.sh, nicht einchecken)")
for key, value in config.items():
    value = str(value)
    for ch in ("\\", "\"", "$", "`"):
        value = value.replace(ch, "\\" + ch)
    print(key + "=\"" + value + "\"")
' > "$CONF.tmp" || die "Antwort der Plattform nicht lesbar."
  chmod 600 "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
  log "Konfiguration gespeichert ($CONF)."
fi

# shellcheck disable=SC1090
. "$CONF"
[ -n "${STROMKREIS_SITE_TOKEN:-}" ] || die "Konfiguration ohne Anlagen-Token ($CONF loeschen und neu versuchen)."
BASE="${STROMKREIS_BASE_URL:-$BASE}"

report() { # report <phase> [message]
  curl -fsS -m 15 -H 'Content-Type: application/json' \
    -d "{\"token\":\"$STROMKREIS_SITE_TOKEN\",\"phase\":\"$1\",\"message\":\"${2:-}\",\"hostname\":\"$(hostname)\"}" \
    "$BASE/api/gateway/provision/v1/result" >/dev/null 2>&1 || true
}

report konfiguration "Konfiguration geladen, Profil ${INVERTER_PROFILE:-unbekannt}"

# --- 2. Gateway-Paket laden und entpacken ------------------------------------
TARBALL_URL="$BASE/gateway/stromkreis-gateway.tgz"
CHECKSUM_URL="$TARBALL_URL.sha256"

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

log "Lade Paket: $TARBALL_URL"
if ! curl -fsSL -m 300 -o "$tmp/stromkreis-gateway.tgz" "$TARBALL_URL"; then
  log "Gateway-Paket noch nicht verfuegbar oder Plattform nicht erreichbar - naechster Versuch spaeter."
  report unvollstaendig "Wartet auf das Gateway-Paket ($TARBALL_URL)"
  exit 75
fi

log "Lade Pruefsumme: $CHECKSUM_URL"
curl -fsSL -m 30 -o "$tmp/stromkreis-gateway.tgz.sha256" "$CHECKSUM_URL" \
  || die "Pruefsumme nicht abrufbar: $CHECKSUM_URL"
( cd "$tmp" && sha256sum -c stromkreis-gateway.tgz.sha256 >/dev/null 2>&1 ) \
  || die "Pruefsumme stimmt nicht. Download abgebrochen - bitte erneut versuchen."
log "Pruefsumme OK."

if [ -d "$DEST/openhab" ]; then
  backup="$DEST/openhab.bak-$(date +%Y%m%d%H%M%S)"
  log "Bestehende Installation wird gesichert: $backup"
  mv "$DEST/openhab" "$backup"
fi

mkdir -p "$DEST"
tar -xzf "$tmp/stromkreis-gateway.tgz" -C "$DEST" || die "Entpacken fehlgeschlagen."
[ -d "$DEST/openhab/setup" ] || die "Paket unerwartet aufgebaut - $DEST/openhab/setup fehlt."

# Pruefsumme des installierten Pakets: der Selbst-Update-Timer
# (stromkreis-update) vergleicht sie naechtlich mit der auf der Plattform.
cp "$tmp/stromkreis-gateway.tgz.sha256" "$DEST/openhab/PACKAGE-SHA256"

chmod +x "$DEST/openhab/setup"/*.sh "$DEST/openhab/setup/lib"/*.sh 2>/dev/null || true

log "Entpackt nach: $DEST/openhab"
[ -f "$DEST/openhab/BUILD-INFO" ] && sed "s/^/$LOG_PREFIX /" "$DEST/openhab/BUILD-INFO"

# --- 3. Einrichtung ----------------------------------------------------------
log "Starte Einrichtung ..."
exec "$DEST/openhab/setup/install-gateway.sh"
