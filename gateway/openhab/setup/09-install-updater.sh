#!/usr/bin/env bash
# ============================================================================
# 09 - Selbst-Update des Gateway-Pakets
#
# Richtet einen root-Timer (stromkreis-update.timer, alle 10 Minuten) ein, der das
# Gateway-Paket von stromkreis.net neu einspielt:
#   * sofort, wenn der Betreiber am Dashboard "Paket aktualisieren" gedrueckt
#     hat - der Status-Push (stromkreis_status_push.js) bekommt das in der Antwort
#     und legt die Marker-Datei $GW_UPDATE_FLAG an;
#   * sonst einmal taeglich zwischen 03:00 und 05:00, wenn die Pruefsumme
#     des Pakets auf dem Server von der installierten abweicht
#     (INSTALL_AUTO_UPDATE=1, Vorgabe).
# Das Update ist der normale Bootstrap (gateway/install.sh): Paket laden,
# Pruefsumme, gateway.conf uebernehmen, install-gateway.sh. Log: /var/log/stromkreis-update.log
# und journalctl -u stromkreis-update.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_config

UPDATER=/usr/local/sbin/stromkreis-update
UNIT_DIR=/etc/systemd/system

if [ "$INSTALL_AUTO_UPDATE" != "1" ]; then
  if systemctl is-enabled --quiet stromkreis-update.timer 2>/dev/null; then
    systemctl disable --now stromkreis-update.timer >/dev/null 2>&1 || true
    log "INSTALL_AUTO_UPDATE=0 - stromkreis-update.timer abgeschaltet."
  else
    log "INSTALL_AUTO_UPDATE=0 - Selbst-Update uebersprungen."
  fi
  exit 0
fi

# Marker-Verzeichnis: der Status-Push laeuft als openHAB-Benutzer und muss
# die Anforderung dort ablegen koennen; der Timer laeuft als root.
mkdir -p "$GW_REQUEST_DIR"
chown "$OPENHAB_USER:$OPENHAB_GROUP" "$GW_REQUEST_DIR" 2>/dev/null || true
chmod 0755 "$GW_REQUEST_DIR"

install_file "$UPDATER" <<'UPD'
#!/usr/bin/env bash
# stromkreis-update - spielt das Gateway-Paket von stromkreis.net neu ein.
# Erzeugt von 09-install-updater.sh; Aufruf durch stromkreis-update.timer (root).
#   stromkreis-update            regulaerer Timer-Lauf (Marker oder Nachtfenster)
#   stromkreis-update --now      sofort aktualisieren (von Hand)
set -uo pipefail

# Der gesamte Ablauf steckt in einer Funktion: so liest bash die komplette
# Datei ein, bevor etwas laeuft. Noetig, weil install.sh dieses Skript
# waehrend des Updates in-place ueberschreibt - ohne Funktion liest bash
# danach am alten Datei-Offset weiter und stolpert mitten in einer Zeile
# (Syntaxfehler nach eigentlich fertigem Update).
main() {

CONF=@GW_CONF@
FLAG=@GW_UPDATE_FLAG@
STAMP=@GW_REQUEST_DIR@/last-check
LOG=/var/log/stromkreis-update.log
INSTALLED=@GW_SETUP_DIR@/../PACKAGE-SHA256
LOCK=/run/stromkreis-update.lock

log() { echo "[stromkreis-update] $(date '+%F %T') $*" | tee -a "$LOG"; }

exec 9>"$LOCK"
flock -n 9 || { log "Ein Update laeuft bereits."; exit 0; }

base=https://stromkreis.net
# shellcheck disable=SC1090
[ -f "$CONF" ] && base="$(. "$CONF" 2>/dev/null; echo "${STROMKREIS_BASE_URL:-https://stromkreis.net}")"

reason=""
if [ "${1:-}" = "--now" ]; then
  reason="von Hand"
elif [ -f "$FLAG" ]; then
  reason="vom Dashboard angefordert"
else
  hour=$(date +%H); today=$(date +%F)
  if [ "$hour" -ge 3 ] && [ "$hour" -lt 5 ] && [ "$(cat "$STAMP" 2>/dev/null || true)" != "$today" ]; then
    echo "$today" > "$STAMP"
    remote="$(curl -fsSL -m 30 "$base/gateway/stromkreis-gateway.tgz.sha256" 2>/dev/null | awk '{print $1}' || true)"
    local_sha="$(awk '{print $1}' "$INSTALLED" 2>/dev/null || true)"
    if [ -z "$remote" ]; then
      log "Naechtliche Pruefung: Pruefsumme nicht abrufbar ($base) - kein Update."
      exit 0
    fi
    if [ "$remote" = "$local_sha" ]; then
      log "Naechtliche Pruefung: Paket ist aktuell."
      exit 0
    fi
    reason="neues Paket auf $base"
  fi
fi
[ -n "$reason" ] || exit 0

rm -f "$FLAG"
log "Update startet ($reason) ..."
if ! curl -fsSL -m 60 "$base/gateway/install.sh" -o /run/stromkreis-install.sh; then
  log "install.sh nicht erreichbar ($base) - Update abgebrochen."
  exit 1
fi
rc=0
STROMKREIS_ASSUME_YES=1 STROMKREIS_BASE_URL="$base" bash /run/stromkreis-install.sh >> "$LOG" 2>&1 || rc=$?
rm -f /run/stromkreis-install.sh
# install.sh sichert die alte Installation als openhab.bak-<zeit>; nur die
# letzten drei Sicherungen behalten, sonst fuellt sich die SD-Karte.
ls -dt "$(dirname "@GW_SETUP_DIR@")"/openhab.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
if [ "$rc" -eq 0 ]; then
  log "Update abgeschlossen."
elif [ "$rc" -eq 75 ]; then
  log "Update eingespielt, Einrichtung noch unvollstaendig (Exit 75) - siehe Dashboard."
else
  log "Update fehlgeschlagen (Exit $rc) - Details oben in $LOG."
fi
exit "$rc"
}
main "$@"
UPD
sed -i -e "s|@GW_CONF@|$GATEWAY_CONF|g" \
       -e "s|@GW_UPDATE_FLAG@|$GW_UPDATE_FLAG|g" \
       -e "s|@GW_REQUEST_DIR@|$GW_REQUEST_DIR|g" \
       -e "s|@GW_SETUP_DIR@|$GW_SETUP_DIR|g" "$UPDATER"
chown root:root "$UPDATER"
chmod 0755 "$UPDATER"

install_file "$UNIT_DIR/stromkreis-update.service" <<'UNIT'
[Unit]
Description=Stromkreis Speichermanagement - Paket-Update
After=network-online.target openhab.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/stromkreis-update
UNIT
install_file "$UNIT_DIR/stromkreis-update.timer" <<'UNIT'
[Unit]
Description=Stromkreis Speichermanagement - Paket-Update pruefen

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
UNIT
chown root:root "$UNIT_DIR/stromkreis-update.service" "$UNIT_DIR/stromkreis-update.timer"

systemctl daemon-reload
systemctl enable --now stromkreis-update.timer >/dev/null 2>&1 \
  || warn "stromkreis-update.timer konnte nicht aktiviert werden."
log "Selbst-Update eingerichtet: stromkreis-update.timer (alle 10 min; naechtliche Paketpruefung, Dashboard-Anforderung sofort)."
