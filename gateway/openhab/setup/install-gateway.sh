#!/usr/bin/env bash
# ============================================================================
# Stromkreis Speichermanagement - Komplettinstallation auf dem Gateway
#
# Wird vom Bootstrap (platform/static/gateway/install.sh) nach dem Entpacken
# des Pakets gestartet und fuehrt die Einzelschritte aus. Idempotent:
# jederzeit wiederholbar.
#
#   sudo ./install-gateway.sh
#   sudo STROMKREIS_ASSUME_YES=1 ./install-gateway.sh   # ohne Rueckfragen
#
# Reihenfolge: zuerst alles, was keinen Wechselrichter braucht (Passwoerter,
# Addons) - so meldet die Anlage frueh ihren Status, selbst wenn es beim
# Wechselrichter haengt. Jeder Schritt meldet seine Phase an die Plattform.
#
# Exit-Code 75 (EX_TEMPFAIL) heisst "unvollstaendig, spaeter erneut":
# stromkreis-firstboot bzw. stromkreis-update wiederholen den Lauf dann
# automatisch.
# ============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/common.sh"

require_root
require_openhab

EX_TEMPFAIL=75
incomplete=0
incomplete_list=""

# Bei der Zero-Touch-Einrichtung gibt es niemanden, der Rueckfragen
# beantwortet.
if [ -f "$GATEWAY_CONF" ] || [ -f /boot/firmware/stromkreis-provision.conf ] || [ -f /boot/stromkreis-provision.conf ]; then
  export STROMKREIS_ASSUME_YES=1
fi

# Schritt mit Phasenmeldung: step <phase> <skript> [optional]
#   optional=1: Fehler nur warnen (Lauf geht weiter, Phase fehler:<phase>)
step() {
  local phase="$1" script="$2" optional="${3:-0}" rc=0
  report_phase "$phase"
  "$here/$script" || rc=$?
  if [ "$rc" -eq "$EX_TEMPFAIL" ]; then
    incomplete=1
    incomplete_list="${incomplete_list:+$incomplete_list, }$phase"
    warn "$script: noch nicht abgeschlossen - wird spaeter wiederholt."
  elif [ "$rc" -ne 0 ]; then
    if [ "$optional" = "1" ]; then
      warn "$script fehlgeschlagen (Exit $rc) - spaeter erneut: sudo $here/$script"
      report_phase "fehler:$phase" "$script fehlgeschlagen (Exit $rc), Installation laeuft weiter."
    else
      report_phase "fehler:$phase" "$script fehlgeschlagen (Exit $rc)."
      die "$script fehlgeschlagen (Exit $rc)."
    fi
  fi
}

log "=== Schritt 1/10: Konfiguration ==="
rc=0; "$here/00-provision.sh" || rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

load_config

log "=== Schritt 2/10: Zeitzone und Regionaleinstellungen ==="
ensure_regional_settings

log "=== Schritt 3/10: Standardpasswoerter ==="
step passwoerter 10-change-passwords.sh 1

log "=== Schritt 4/10: Addons ==="
step addons 02-install-addons.sh

log "=== Schritt 5/10: Preflight ==="
if ! "$here/01-preflight.sh"; then
  warn "Preflight meldet Probleme."
  confirm "Trotzdem fortfahren?" || die "Abgebrochen."
fi

log "=== Schritt 6/10: Wechselrichter-Thing ==="
step wechselrichter 02b-install-things.sh 1

log "=== Schritt 7/10: Items und Persistence ==="
step items 03-install-items.sh

log "=== Schritt 8/10: Regeln ==="
step regeln 04-install-rules.sh

log "=== Schritt 9/10: Overview-Seite und Selbst-Update ==="
step overview 05-install-overview.sh 1
step updater 09-install-updater.sh 1

log "=== Schritt 10/10: Verify ==="
"$here/06-verify.sh" || warn "Verify meldet Probleme - siehe oben."

if [ "$incomplete" = "1" ]; then
  # Sammelphase fuer die Plattform: die spaeteren Schritte haben ihre Phasen
  # schon gemeldet, deshalb hier den Wartezustand samt der offenen Schritte
  # nachtragen (stromkreis-firstboot wiederholt den Lauf).
  report_phase unvollstaendig "Wartet auf: ${incomplete_list}. Der Lauf wird automatisch wiederholt."
  cat <<ENDE
[Stromkreis]
[Stromkreis] ===========================================================
[Stromkreis]  Installation noch nicht vollstaendig.
[Stromkreis] ===========================================================
[Stromkreis]
[Stromkreis] Ein Schritt wartet noch (z. B. auf das Passwort des
[Stromkreis] Wechselrichters oder auf den Wechselrichter selbst). Der Lauf
[Stromkreis] wird automatisch wiederholt (stromkreis-firstboot) bzw. von
[Stromkreis] Hand: sudo $here/install-gateway.sh
[Stromkreis]
ENDE
  exit "$EX_TEMPFAIL"
fi

report_phase fertig "Installation abgeschlossen."

cat <<ENDE
[Stromkreis]
[Stromkreis] ===========================================================
[Stromkreis]  Installation abgeschlossen.
[Stromkreis] ===========================================================
[Stromkreis]
[Stromkreis] Wechselrichter: ${INVERTER_LABEL}
[Stromkreis] Thing-UID:      ${INVERTER_THING_UID}
[Stromkreis]
[Stromkreis] Alles wurde automatisch eingerichtet (Thing, Zugangsdaten,
[Stromkreis] Items, Admin-Konto, Regeln, Selbst-Update). Der Hauptschalter
[Stromkreis] steht auf ${DEFAULT_MAIN_SWITCH}.
[Stromkreis]
[Stromkreis] Logs beobachten:
[Stromkreis]   tail -f ${OPENHAB_LOGDIR}/openhab.log | grep '\[Stromkreis\]'
[Stromkreis]
ENDE
