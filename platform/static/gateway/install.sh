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
#   2. Fortschritt an die Plattform melden (POST /api/gateway/provision/v1/result).
#   3. Gateway-Paket des Wechselrichterprofils installieren. Solange das
#      Paket fuer das Profil noch nicht veroeffentlicht ist, endet der Lauf
#      mit Exit 75 ("unvollstaendig"); stromkreis-firstboot versucht es dann
#      alle 10 Minuten erneut und setzt automatisch fort, sobald das Paket da ist.
# ============================================================================
set -uo pipefail

CONF=/etc/stromkreis/gateway.conf
LOG_PREFIX="[stromkreis-install]"

log() { echo "$LOG_PREFIX $*"; }
die() { log "FEHLER: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "bitte als root ausfuehren."
command -v curl >/dev/null || die "curl fehlt."
command -v python3 >/dev/null || die "python3 fehlt."

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
    print(f"{key}={json.dumps(str(value))}")
' > "$CONF.tmp" || die "Antwort der Plattform nicht lesbar."
  chmod 600 "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
  log "Konfiguration gespeichert ($CONF)."
fi

# shellcheck disable=SC1090
. "$CONF"
[ -n "${STROMKREIS_SITE_TOKEN:-}" ] || die "Konfiguration ohne Anlagen-Token ($CONF loeschen und neu versuchen)."

report() { # report <phase> [message]
  curl -fsS -m 15 -H 'Content-Type: application/json' \
    -d "{\"token\":\"$STROMKREIS_SITE_TOKEN\",\"phase\":\"$1\",\"message\":\"${2:-}\",\"hostname\":\"$(hostname)\"}" \
    "$BASE/api/gateway/provision/v1/result" >/dev/null 2>&1 || true
}

report konfiguration "Konfiguration geladen, Profil ${INVERTER_PROFILE:-unbekannt}"

# --- 3. Gateway-Paket installieren ------------------------------------------
# Die Gateway-Pakete je Wechselrichterprofil (gateway/profiles/ im Repo) sind
# noch nicht als Download veroeffentlicht. Bis dahin: warten und automatisch
# fortsetzen, sobald das Paket unter $BASE/gateway/<profil>.tgz erscheint.
profile="${INVERTER_PROFILE:-}"
if [ -n "$profile" ] && curl -fsIL -m 30 "$BASE/gateway/$profile.tgz" >/dev/null 2>&1; then
  die "Gateway-Paket $profile.tgz gefunden, aber dieser Installer kennt es noch nicht (install.sh aktualisieren)."
fi
log "Gateway-Paket fuer Profil '${profile:-?}' noch nicht verfuegbar - Konfiguration liegt bereit, warte."
report unvollstaendig "Wartet auf das Gateway-Paket '${profile:-?}'"
exit 75
