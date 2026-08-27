#!/usr/bin/env bash
# ============================================================================
# stromkreis-firstboot - startet die Zero-Touch-Einrichtung des Stromkreis-
# Gateways nach der openHABian-Erstinstallation.
#
# Wird von cloud-init beim ersten Boot aus der user-data der Boot-Partition
# installiert (/usr/local/sbin/stromkreis-firstboot, systemd-Unit
# stromkreis-firstboot.service; beides steckt im SD-Karten-Image von der
# Plattform) und laeuft bei jedem Boot, bis die Einrichtung abgeschlossen ist:
#
#   1. Ohne /boot/firmware/stromkreis-provision.conf (Einrichtungscode vom
#      Betreiber) nichts tun.
#   2. Warten, bis openHABian fertig ist (/opt/openHABian-install-successful;
#      openHABian startet danach selbst neu) und openHAB per REST antwortet.
#   3. install.sh von STROMKREIS_BASE_URL laden und ausfuehren (der Code wird
#      dort von der Boot-Partition gelesen, keine Rueckfragen).
#   4. Erfolg: Marker setzen, stromkreis-provision.conf von der Karte loeschen.
#      Misserfolg oder "unvollstaendig" (Exit 75, z. B. Gateway-Paket noch
#      nicht verfuegbar): in 10 Minuten erneut, ohne Neustart.
#
# Log: journalctl -u stromkreis-firstboot  und  /var/log/stromkreis-firstboot.log
# ============================================================================
set -uo pipefail

MARKER=/var/lib/stromkreis/provisioned
LOG=/var/log/stromkreis-firstboot.log
RETRY_SECONDS=600

log() { echo "[stromkreis-firstboot] $(date '+%F %T') $*" | tee -a "$LOG"; }

conf=""
for f in /boot/firmware/stromkreis-provision.conf /boot/stromkreis-provision.conf; do
  [ -f "$f" ] && { conf="$f"; break; }
done
if [ -f "$MARKER" ]; then
  log "Einrichtung bereits abgeschlossen ($MARKER)."
  [ -n "$conf" ] && rm -f "$conf"
  exit 0
fi
if [ -z "$conf" ]; then
  log "Keine stromkreis-provision.conf auf der Boot-Partition - nichts zu tun."
  exit 0
fi

# --- auf openHABian und openHAB warten --------------------------------------
while [ ! -f /opt/openHABian-install-successful ]; do
  if [ -f /opt/openHABian-install-failed ]; then
    log "openHABian meldet eine fehlgeschlagene Erstinstallation - warte auf Neustart/erneuten Versuch."
  fi
  sleep 60
done
log "openHABian-Erstinstallation abgeschlossen; warte auf openHAB ..."
until [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8080/rest/ 2>/dev/null)" = "200" ]; do
  sleep 15
done
log "openHAB antwortet."

# --- Einrichtung, mit Wiederholung ------------------------------------------
while :; do
  # shellcheck disable=SC1090
  . "$conf"
  base="${STROMKREIS_BASE_URL:-https://stromkreis.net}"
  log "Starte Einrichtung von $base (Code ${STROMKREIS_PROVISION_CODE:-?}) ..."
  rc=0
  if curl -fsSL -m 60 "$base/gateway/install.sh" -o /run/stromkreis-install.sh; then
    STROMKREIS_PROVISION_CODE="${STROMKREIS_PROVISION_CODE:-}" STROMKREIS_BASE_URL="$base" STROMKREIS_ASSUME_YES=1 \
      bash /run/stromkreis-install.sh >> "$LOG" 2>&1 || rc=$?
  else
    rc=1
    log "install.sh nicht erreichbar ($base) - Internetverbindung?"
  fi

  if [ "$rc" -eq 0 ]; then
    mkdir -p "$(dirname "$MARKER")"
    date '+%F %T' > "$MARKER"
    rm -f "$conf"
    log "Einrichtung abgeschlossen."
    exit 0
  fi
  if [ "$rc" -eq 75 ]; then
    log "Einrichtung noch unvollstaendig - naechster Versuch in $((RETRY_SECONDS / 60)) Minuten."
  else
    log "Einrichtung fehlgeschlagen (Exit $rc) - naechster Versuch in $((RETRY_SECONDS / 60)) Minuten. Details: $LOG"
  fi
  sleep "$RETRY_SECONDS"
done
