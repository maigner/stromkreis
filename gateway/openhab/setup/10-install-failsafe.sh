#!/usr/bin/env bash
# ============================================================================
# 10 - Fail-Safe fuer Wechselrichter ohne geraeteseitiges Auto-Revert
#
# Die Modbus-Profile (fronius-snapinverter, sigenergy, deye, victron)
# schreiben Register, die stehen bleiben, wenn openHAB ausfaellt - anders
# als die GEN24-Schedules, die von selbst ablaufen. Der Kern setzt zwar in
# jedem 5-Minuten-Zyklus zurueck, aber nur solange er laeuft. Dieses Skript
# richtet die Absicherung AUSSERHALB von openHAB ein (Analyse und Testplan:
# inverters/failsafe-modbus.md):
#
#   * stromkreis-failsafe.timer (root, jede Minute): prueft den Heartbeat, den der
#     Kern nach jedem bestaetigten Reset schreibt (GW_HEARTBEAT_FILE), und
#     ob openhab.service aktiv ist. Ist der Heartbeat aelter als
#     FAILSAFE_STALE_MIN Minuten oder openHAB nicht aktiv, schreibt der
#     Timer das Werksverhalten direkt per Modbus (inverter_failsafe_reset
#     des Profils, eigene TCP-Verbindung, kein Java) und wiederholt das
#     alle FAILSAFE_REPEAT_MIN Minuten, bis der Heartbeat zurueck ist.
#   * stromkreis-failsafe-boot.service: derselbe Reset bei jedem Boot, vor dem
#     Start von openHAB (wiederholt bis zu zwei Minuten, falls das Geraet
#     noch nicht erreichbar ist) - deckt Stromausfall und Reboot ab, auch
#     wenn openHAB danach gar nicht mehr hochkommt.
#   * Drop-in fuer openhab.service: Restart=on-failure.
#   * Standby: steht der Hauptschalter auf AUS, hat der Kern einen letzten
#     Reset geschickt und den Marker GW_FAILSAFE_STANDBY angelegt - Timer
#     und Boot-Reset tun dann NICHTS, das Mitglied darf den Wechselrichter
#     anders steuern. Beim Einschalten entfernt der Kern den Marker.
#   * Optional (INSTALL_HW_WATCHDOG=1): Hardware-Watchdog ueber systemd
#     (RuntimeWatchdogSec), damit ein eingefrorener Pi neu startet und der
#     Boot-Reset greift. Vorgabe aus - ein Pi im Swap-Stau wuerde hart
#     neu gestartet, das will bewusst entschieden sein.
#
# Was der Fail-Safe NICHT kann: einen hart toten Pi (Netzteil, SD-Karte)
# ersetzen. Dann bleibt der geraeteseitige Ladestands-Boden und die
# Offline-Anzeige der Plattform (siehe failsafe-modbus.md).
#
# Profile ohne inverter_failsafe_reset (GEN24) brauchen nichts davon;
# vorhandene Units werden dann entfernt. INSTALL_FAILSAFE=0 in gateway.conf
# schaltet alles ab. Log: /var/log/stromkreis-failsafe.log und
# journalctl -u stromkreis-failsafe. Von Hand: stromkreis-failsafe --status | --now.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_config

FAILSAFE=/usr/local/sbin/stromkreis-failsafe
UNIT_DIR=/etc/systemd/system

remove_failsafe() {
  local reason="$1"
  if [ -f "$UNIT_DIR/stromkreis-failsafe.timer" ] || [ -f "$FAILSAFE" ]; then
    systemctl disable --now stromkreis-failsafe.timer stromkreis-failsafe-boot.service >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/stromkreis-failsafe.timer" "$UNIT_DIR/stromkreis-failsafe.service" \
          "$UNIT_DIR/stromkreis-failsafe-boot.service" "$FAILSAFE" \
          "$UNIT_DIR/openhab.service.d/stromkreis-failsafe.conf"
    rmdir "$UNIT_DIR/openhab.service.d" 2>/dev/null || true
    systemctl daemon-reload
    log "$reason - Fail-Safe entfernt."
  else
    log "$reason - Fail-Safe uebersprungen."
  fi
}

if [ "$INSTALL_FAILSAFE" != "1" ]; then
  remove_failsafe "INSTALL_FAILSAFE=0"
  exit 0
fi
if ! type inverter_failsafe_reset >/dev/null 2>&1; then
  remove_failsafe "Profil '$INVERTER_PROFILE' ohne inverter_failsafe_reset (Kommandos laufen am Geraet selbst ab)"
  exit 0
fi

# Heartbeat schreibt der Kern als openHAB-Benutzer, Zustand und Stempel der
# root-Timer - dasselbe Verzeichnis wie die Dashboard-Anforderungen.
mkdir -p "$GW_REQUEST_DIR"
chown "$OPENHAB_USER:$OPENHAB_GROUP" "$GW_REQUEST_DIR" 2>/dev/null || true
chmod 0755 "$GW_REQUEST_DIR"

# --- /usr/local/sbin/stromkreis-failsafe ---------------------------------------------
# Wie stromkreis-update: Rumpf in main, atomar ersetzt (das Paket-Update schreibt
# die Datei neu, waehrend ein Timer-Lauf sie noch ausfuehren kann).
failsafe_tmp="$(mktemp "$FAILSAFE.XXXXXX")"
cat > "$failsafe_tmp" <<'FS'
#!/usr/bin/env bash
# stromkreis-failsafe - setzt den Wechselrichter ohne openHAB auf Werksverhalten.
# Erzeugt von 10-install-failsafe.sh; Aufruf durch stromkreis-failsafe.timer (root,
# jede Minute) und stromkreis-failsafe-boot.service (vor openHAB).
#   stromkreis-failsafe            Timer-Lauf: Heartbeat pruefen, bei Bedarf Reset
#   stromkreis-failsafe --boot     Boot-Reset, wiederholt bis erreichbar (max. 2 min)
#   stromkreis-failsafe --now      Reset sofort (von Hand)
#   stromkreis-failsafe --status   Zustand anzeigen
set -uo pipefail

main() {
SETUP_DIR=@GW_SETUP_DIR@
STALE_MIN=@FAILSAFE_STALE_MIN@
REPEAT_MIN=@FAILSAFE_REPEAT_MIN@
LOG="${GW_FAILSAFE_LOG:-/var/log/stromkreis-failsafe.log}"
LOCK="${GW_FAILSAFE_LOCK:-/run/stromkreis-failsafe.lock}"

fslog() { echo "[stromkreis-failsafe] $(date '+%F %T') $*" | tee -a "$LOG"; }

take_lock() {
  exec 9>"$LOCK"
  flock -n 9 || exit 0
}

# Profil laden, ohne das Journal minuetlich mit Hinweisen zu fuellen.
export GW_QUIET=1
# shellcheck disable=SC1091
. "$SETUP_DIR/lib/common.sh"
[ -f "$GATEWAY_CONF" ] || { fslog "gateway.conf fehlt - nichts zu tun."; exit 0; }
# shellcheck disable=SC1090
. "$GATEWAY_CONF"
load_profile "${INVERTER_PROFILE:-fronius-symo}"
type inverter_failsafe_reset >/dev/null 2>&1 || exit 0

HB="$GW_HEARTBEAT_FILE"
STANDBY="$GW_FAILSAFE_STANDBY"
STATUS="$GW_FAILSAFE_STATUS"
STAMP="$GW_REQUEST_DIR/failsafe-last-reset"
COUNT="$GW_REQUEST_DIR/failsafe-count"

# Adresse des Wechselrichters: zuerst aus dem Bridge-Thing der JSONDB (der
# Netzwerk-Watchdog haelt sie nach DHCP-Wechseln aktuell), ersatzweise aus
# gateway.conf (02b gleicht beide beim Paket-Update ab).
resolve_host() {
  local host="" uid
  for uid in "${INVERTER_HOST_THING_UID:-}" "${INVERTER_HOST_THING_PREFIX:+${INVERTER_HOST_THING_PREFIX}:stromkreis}"; do
    [ -n "$uid" ] || continue
    host="$(thing_config_param "$uid" "${INVERTER_HOST_PARAM:-hostname}")"
    [ -n "$host" ] && break
  done
  [ -n "$host" ] || host="${INVERTER_HOST:-}"
  printf '%s' "$host"
}

# Zustand fuer den Status-Push (JSON, fuer den openHAB-Benutzer lesbar).
#   $1 ergebnis (reset|fehler)  $2 grund  $3 meldung
write_status() {
  GW_FS_ERGEBNIS="$1" GW_FS_GRUND="$2" GW_FS_MELDUNG="$3" \
  GW_FS_ANZAHL="$(cat "$COUNT" 2>/dev/null || echo 0)" GW_FS_OUT="$STATUS" python3 - <<'PYJ'
import datetime, json, os
out = os.environ["GW_FS_OUT"]
with open(out + ".tmp", "w") as f:
    json.dump({"zeit": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "ergebnis": os.environ["GW_FS_ERGEBNIS"],
               "grund": os.environ["GW_FS_GRUND"],
               "meldung": os.environ["GW_FS_MELDUNG"][:300],
               "anzahl": int(os.environ["GW_FS_ANZAHL"] or 0)}, f, ensure_ascii=False)
os.replace(out + ".tmp", out)
PYJ
  chmod 0644 "$STATUS" 2>/dev/null || true
}

# Reset schreiben; Exit 0 nur bei vom Profil bestaetigtem Reset.
#   $1 Grund (fuers Log und den Status-Push)
do_reset() {
  local host out rc
  host="$(resolve_host)"
  if [ -z "$host" ]; then
    fslog "Keine Adresse des Wechselrichters bekannt (Bridge-Thing, gateway.conf) - Reset nicht moeglich ($1)."
    write_status fehler "$1" "keine Adresse bekannt"
    return 1
  fi
  out="$(inverter_failsafe_reset "$host" 2>&1)"; rc=$?
  out="$(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')"
  if [ "$rc" -eq 0 ]; then
    date +%s > "$STAMP"
    echo "$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 ))" > "$COUNT"
    fslog "Reset geschrieben ($1) an $host: $out"
    write_status reset "$1" "$out"
  else
    fslog "Reset fehlgeschlagen ($1, Exit $rc) an $host: $out"
    write_status fehler "$1" "$out"
  fi
  return "$rc"
}

timer_run() {
  local now hb age active=1 reason last
  take_lock
  # Hauptschalter AUS: der Kern hat den letzten Reset geschickt, ab hier
  # gehoert der Wechselrichter dem Mitglied (anderes EMS, Hersteller-App).
  if [ -f "$STANDBY" ]; then
    rm -f "$STAMP"
    exit 0
  fi
  now=$(date +%s)
  systemctl is-active --quiet openhab.service || active=0
  # Noch kein Zyklus mit bestaetigtem Reset (frische Installation): es kann
  # nichts stehen geblieben sein; den Boot deckt --boot ab.
  [ -f "$HB" ] || exit 0
  hb=$(stat -c %Y "$HB" 2>/dev/null || echo 0)
  age=$(( (now - hb) / 60 ))
  if [ "$active" -eq 1 ] && [ "$age" -lt "$STALE_MIN" ]; then
    if [ -f "$STAMP" ]; then
      fslog "Heartbeat zurueck (${age} min alt, openHAB aktiv) - Fail-Safe wieder in Bereitschaft."
      rm -f "$STAMP"
    fi
    exit 0
  fi
  if [ "$active" -eq 0 ]; then
    reason="openhab.service nicht aktiv"
  else
    reason="Heartbeat ${age} min alt"
  fi
  # Waehrend eines Ausfalls alle REPEAT_MIN Minuten erneut schreiben - falls
  # openHAB zwischendurch kurz lebte und ein Fenster setzte. Ein
  # fehlgeschlagener Reset (kein Stempel) wird jede Minute wiederholt.
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ "$last" -gt 0 ] && [ $(( (now - last) / 60 )) -lt "$REPEAT_MIN" ]; then
    exit 0
  fi
  do_reset "$reason"
}

boot_run() {
  local i
  take_lock
  if [ -f "$STANDBY" ]; then
    fslog "Standby (Hauptschalter AUS) - kein Boot-Reset, der Wechselrichter bleibt unangetastet."
    return 0
  fi
  for i in 1 2 3 4 5 6 7 8; do
    do_reset "Boot" && return 0
    sleep 15
  done
  fslog "Boot-Reset nicht gelungen - stromkreis-failsafe.timer versucht es weiter."
  return 1
}

status_run() {
  local hb now
  now=$(date +%s)
  echo "Profil:          ${INVERTER_PROFILE} (inverter_failsafe_reset vorhanden)"
  echo "Adresse:         $(resolve_host)"
  echo "openhab.service: $(systemctl is-active openhab.service 2>/dev/null || true)"
  if [ -f "$STANDBY" ]; then
    echo "Standby:         JA seit $(date -r "$STANDBY" '+%F %T') - Hauptschalter AUS, Timer und Boot-Reset ruhen"
  else
    echo "Standby:         nein (Hauptschalter EIN oder noch kein Zyklus)"
  fi
  if [ -f "$HB" ]; then
    hb=$(stat -c %Y "$HB")
    echo "Heartbeat:       $(date -d "@$hb" '+%F %T') ($(( (now - hb) / 60 )) min alt, Schwelle ${STALE_MIN} min)"
  else
    echo "Heartbeat:       noch keiner (entsteht mit dem ersten bestaetigten Reset des Kerns)"
  fi
  if [ -f "$STAMP" ]; then
    echo "Letzter Reset:   $(date -d "@$(cat "$STAMP")" '+%F %T') - Ausfall laeuft, Wiederholung alle ${REPEAT_MIN} min"
  else
    echo "Letzter Reset:   keiner im laufenden Ausfall"
  fi
  [ -f "$STATUS" ] && echo "Zustand:         $(cat "$STATUS")"
  [ -f "$LOG" ] && { echo "Log (letzte 5 Zeilen):"; tail -n 5 "$LOG"; }
  return 0
}

case "${1:-}" in
  --boot)   boot_run ;;
  --now)    take_lock; do_reset "von Hand" ;;
  --status) status_run ;;
  "")       timer_run ;;
  *) echo "Aufruf: stromkreis-failsafe [--boot|--now|--status]" >&2; exit 2 ;;
esac
}

main "$@"
exit
FS
sed -i -e "s|@GW_SETUP_DIR@|$GW_SETUP_DIR|g" \
       -e "s|@FAILSAFE_STALE_MIN@|$FAILSAFE_STALE_MIN|g" \
       -e "s|@FAILSAFE_REPEAT_MIN@|$FAILSAFE_REPEAT_MIN|g" "$failsafe_tmp"
chown root:root "$failsafe_tmp"
chmod 0755 "$failsafe_tmp"
if [ -f "$FAILSAFE" ] && cmp -s "$failsafe_tmp" "$FAILSAFE"; then
  rm -f "$failsafe_tmp"
  log "unveraendert: $FAILSAFE"
else
  mv -f "$failsafe_tmp" "$FAILSAFE"
  log "geschrieben: $FAILSAFE"
fi

# --- Units ------------------------------------------------------------------------
install_file "$UNIT_DIR/stromkreis-failsafe.service" <<'UNIT'
[Unit]
Description=Stromkreis Speichermanagement - Fail-Safe (Wechselrichter-Reset ohne openHAB)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/stromkreis-failsafe
UNIT
install_file "$UNIT_DIR/stromkreis-failsafe.timer" <<'UNIT'
[Unit]
Description=Stromkreis Speichermanagement - Fail-Safe pruefen

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT
install_file "$UNIT_DIR/stromkreis-failsafe-boot.service" <<'UNIT'
[Unit]
Description=Stromkreis Speichermanagement - Fail-Safe-Reset beim Start
After=network-online.target
Wants=network-online.target
Before=openhab.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/stromkreis-failsafe --boot
TimeoutStartSec=170

[Install]
WantedBy=multi-user.target
UNIT
# openHAB nach einem Absturz selbst neu starten - der Timer setzt den
# Wechselrichter in der Zwischenzeit zurueck.
mkdir -p "$UNIT_DIR/openhab.service.d"
install_file "$UNIT_DIR/openhab.service.d/stromkreis-failsafe.conf" <<'UNIT'
# Erzeugt von Stromkreis (10-install-failsafe.sh)
[Service]
Restart=on-failure
RestartSec=30
UNIT
chown root:root "$UNIT_DIR/stromkreis-failsafe.service" "$UNIT_DIR/stromkreis-failsafe.timer" \
      "$UNIT_DIR/stromkreis-failsafe-boot.service" "$UNIT_DIR/openhab.service.d/stromkreis-failsafe.conf"

# --- Hardware-Watchdog (optional) --------------------------------------------------
wd_conf=/etc/systemd/system.conf.d/stromkreis-watchdog.conf
if [ "$INSTALL_HW_WATCHDOG" = "1" ]; then
  if [ -e /dev/watchdog ]; then
    mkdir -p /etc/systemd/system.conf.d
    install_file "$wd_conf" <<'UNIT'
# Erzeugt von Stromkreis (10-install-failsafe.sh): systemd bedient den Hardware-
# Watchdog des Pi; bleibt PID 1 15 Sekunden stehen, startet der Pi neu und
# stromkreis-failsafe-boot.service setzt den Wechselrichter zurueck.
[Manager]
RuntimeWatchdogSec=15s
UNIT
    chown root:root "$wd_conf"
    systemctl daemon-reexec || warn "systemd daemon-reexec fehlgeschlagen - Watchdog erst nach dem naechsten Boot aktiv."
    log "Hardware-Watchdog aktiv (RuntimeWatchdogSec=15s)."
  else
    warn "INSTALL_HW_WATCHDOG=1, aber /dev/watchdog fehlt - Hardware-Watchdog uebersprungen."
  fi
elif [ -f "$wd_conf" ]; then
  rm -f "$wd_conf"
  systemctl daemon-reexec || true
  log "Hardware-Watchdog abgeschaltet (INSTALL_HW_WATCHDOG=0)."
fi

systemctl daemon-reload
systemctl enable --now stromkreis-failsafe.timer >/dev/null 2>&1 \
  || warn "stromkreis-failsafe.timer konnte nicht aktiviert werden."
systemctl enable stromkreis-failsafe-boot.service >/dev/null 2>&1 \
  || warn "stromkreis-failsafe-boot.service konnte nicht aktiviert werden."

log "Fail-Safe eingerichtet: stromkreis-failsafe.timer (jede Minute; Reset bei Heartbeat > ${FAILSAFE_STALE_MIN} min oder openHAB inaktiv, Wiederholung alle ${FAILSAFE_REPEAT_MIN} min), Boot-Reset vor openHAB."
"$FAILSAFE" --status 2>/dev/null | sed -n '2p' | sed 's/^/[Stromkreis] Fail-Safe-/' || true
