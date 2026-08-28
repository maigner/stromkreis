#!/usr/bin/env bash
# ============================================================================
# 00 - Provisionierung: gateway.conf um die profilabhaengigen Werte ergaenzen
#
# Den Einrichtungscode hat der Bootstrap (platform/static/gateway/install.sh)
# bereits bei der Plattform eingeloest und die Antwort nach
# /etc/stromkreis/gateway.conf geschrieben (Anlagen-Token, Plattform-URL,
# Profil, Kennwerte). Dieses Skript macht die Konfiguration komplett:
#
#   1. erkennt das Wechselrichter-Profil, wenn die Plattform keines vorgibt
#      (INVERTER_PROFILE leer): Netzsuche aller Profile unter ../inverters/.
#      Genau ein Treffer -> uebernehmen. Sonst Phase "wechselrichter_unklar"
#      melden und alle 5 Minuten neu suchen bzw. auf die Wahl des Betreibers
#      auf der Plattform warten,
#   2. sucht die Netzwerkadresse des Wechselrichters (falls erreichbar),
#   3. ergaenzt die profilabhaengigen Schluessel in der gateway.conf
#      (Thing-UID, Item-Namen, AUTO_CREATE_THING=1).
#
# Idempotent: ist die Konfiguration komplett (STROMKREIS_PROVISIONED=1),
# passiert nichts. Exit 75 = spaeter erneut versuchen (stromkreis-firstboot
# wiederholt automatisch).
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
require_openhab

EX_TEMPFAIL=75

[ -f "$GATEWAY_CONF" ] || die "$GATEWAY_CONF fehlt - zuerst den Bootstrap laufen lassen."
# shellcheck disable=SC1090
. "$GATEWAY_CONF"
[ -n "${STROMKREIS_SITE_TOKEN:-}" ] || die "Konfiguration ohne Anlagen-Token ($GATEWAY_CONF loeschen und Bootstrap erneut ausfuehren)."

if grep -q '^STROMKREIS_PROVISIONED="1"' "$GATEWAY_CONF" 2>/dev/null; then
  log "Konfiguration ist bereits vollstaendig ($GATEWAY_CONF)."
  exit 0
fi

# --- 1. Wechselrichter-Profil -----------------------------------------------
# Netzsuche eines Profils in einer Subshell (Profil-Variablen bleiben draussen).
scan_profile() {
  local profile="$1"
  ( load_profile "$profile" >/dev/null 2>&1 || exit 0
    type inverter_scan_hosts >/dev/null 2>&1 || exit 0
    inverter_scan_hosts 2>/dev/null | head -n 5 ) || true
}

INVERTER_PROFILE="${INVERTER_PROFILE:-}"
INVERTER_HOST="${INVERTER_HOST:-}"
while :; do
  if [ -n "$INVERTER_PROFILE" ]; then
    [ -f "$GW_INVERTER_DIR/$INVERTER_PROFILE/profile.sh" ] \
      || die "Von der Plattform vorgegebenes Profil '$INVERTER_PROFILE' gibt es nicht in $GW_INVERTER_DIR."
    if [ -z "$INVERTER_HOST" ]; then
      mapfile -t hosts < <(scan_profile "$INVERTER_PROFILE")
      INVERTER_HOST="${hosts[0]:-}"
    fi
    break
  fi

  report_phase wechselrichter_suche "Suche den Wechselrichter im lokalen Netz ..."
  found_profiles=(); found_hosts=()
  for profile in $(list_inverters); do
    mapfile -t hosts < <(scan_profile "$profile")
    if [ "${#hosts[@]}" -gt 0 ]; then
      found_profiles+=("$profile"); found_hosts+=("${hosts[0]}")
      log "Profil $profile: ${hosts[*]}"
    fi
  done

  if [ "${#found_profiles[@]}" -eq 1 ]; then
    INVERTER_PROFILE="${found_profiles[0]}"; INVERTER_HOST="${found_hosts[0]}"
    log "Wechselrichter erkannt: $INVERTER_PROFILE ($INVERTER_HOST)"
    break
  fi

  if [ "${#found_profiles[@]}" -eq 0 ]; then
    msg="Kein Wechselrichter im lokalen Netz gefunden. Ist der Wechselrichter im selben Netz wie der Raspberry Pi? Profil auf der Plattform setzen oder warten."
  else
    msg="Mehrere Geraete gefunden:"
    for i in "${!found_profiles[@]}"; do msg="$msg ${found_profiles[$i]} (${found_hosts[$i]})"; done
    msg="$msg. Bitte das Profil auf der Plattform setzen."
  fi
  warn "$msg"
  report_phase wechselrichter_unklar "$msg"

  # Der Betreiber kann das Profil auf der Plattform setzen; die Antwort der
  # Phasenmeldung traegt es. Sonst in 5 Minuten erneut suchen.
  INVERTER_PROFILE="$(report_field inverter_profile)"
  [ -n "$INVERTER_PROFILE" ] && { log "Profil von der Plattform: $INVERTER_PROFILE"; continue; }
  sleep 300
done

load_profile "$INVERTER_PROFILE"
if [ -z "$INVERTER_HOST" ]; then
  warn "Keine Adresse fuer $INVERTER_LABEL gefunden - das Thing wird ohne Adresse angelegt; 02b und der Netzwerk-Watchdog suchen spaeter weiter."
fi
[ -n "${INVERTER_USERNAME:-}" ] || INVERTER_USERNAME="$INVERTER_DEFAULT_USERNAME"

# --- 2. gateway.conf ergaenzen ------------------------------------------------
# Bestehende Schluessel (z. B. ein spaeter nachgetragenes Passwort) bleiben
# stehen; conf_set ersetzt nur die hier genannten.
conf_set INVERTER_PROFILE "$INVERTER_PROFILE"
conf_set INVERTER_THING_UID "$INVERTER_AUTO_THING_UID"
conf_set SOC_ITEM "$INVERTER_SOC_PLACEHOLDER"
conf_set BATTERY_POWER_ITEM "${INVERTER_BATTERY_POWER_PLACEHOLDER:-}"
conf_set GRID_POWER_ITEM "${INVERTER_GRID_POWER_PLACEHOLDER:-}"
conf_set PV_POWER_ITEM "${INVERTER_PV_POWER_PLACEHOLDER:-}"
conf_set AUTO_CREATE_THING "1"
conf_set INVERTER_HOST "$INVERTER_HOST"
conf_set INVERTER_USERNAME "$INVERTER_USERNAME"
grep -q '^INVERTER_PASSWORD=' "$GATEWAY_CONF" || conf_set INVERTER_PASSWORD ""
if [ -n "$INVERTER_HOST_THING_PREFIX" ]; then
  conf_set INVERTER_HOST_THING_UID "${INVERTER_HOST_THING_PREFIX}:stromkreis"
else
  conf_set INVERTER_HOST_THING_UID ""
  conf_set INSTALL_WATCHDOG "0"
fi
conf_set INSTALL_STATUS_PUSH "1"
conf_set STROMKREIS_PROVISIONED "1"
chmod 600 "$GATEWAY_CONF"
log "Konfiguration vervollstaendigt: $GATEWAY_CONF"

cat <<ZUSAMMENFASSUNG
[Stromkreis]
[Stromkreis] Provisionierung
[Stromkreis]   Anlage         : ${STROMKREIS_ANLAGE_NAME:-?}
[Stromkreis]   Wechselrichter : ${INVERTER_LABEL} (${INVERTER_HOST:-Adresse unbekannt})
[Stromkreis]   Plattform      : ${STROMKREIS_BASE_URL:-?}
[Stromkreis]
ZUSAMMENFASSUNG
