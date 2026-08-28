#!/usr/bin/env bash
# ============================================================================
# 05 - Verify: prueft, ob die Installation greift. Aendert nichts.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_openhab
load_config

problems=0
fail() { warn "$*"; problems=$((problems + 1)); }

# --- Dateien ----------------------------------------------------------------
for f in "$OPENHAB_CONF/items/stromkreis.items" \
         "$OPENHAB_CONF/automation/js/stromkreis_cloud_forecast.js" \
         "$OPENHAB_CONF/automation/js/stromkreis_crossover.js" \
         "$OPENHAB_CONF/automation/js/stromkreis_battery_control.js" \
         "$OPENHAB_CONF/automation/js/stromkreis_init.js"; do
  [ -f "$f" ] && log "vorhanden: $f" || fail "fehlt: $f"
done

if [ "$INSTALL_PERSISTENCE" = "1" ]; then
  for svc in mapdb rrd4j; do
    [ -f "$OPENHAB_CONF/persistence/$svc.persist" ] \
      && log "vorhanden: $OPENHAB_CONF/persistence/$svc.persist" \
      || fail "fehlt: $OPENHAB_CONF/persistence/$svc.persist"
    # Datei vorhanden heisst nicht angewendet: wurde sie geschrieben, bevor
    # der Dienst installiert war, kennt openHAB die Konfiguration nicht -
    # dann kein restoreOnStartup und keine Diagramme.
    if [ -n "$OH_API_TOKEN" ]; then
      if persistence_config_loaded "$svc"; then
        log "Persistence-Konfiguration '$svc' ist aktiv."
      else
        fail "openHAB kennt keine Persistence-Konfiguration fuer '$svc' - beheben mit: sudo $GW_SETUP_DIR/03-install-items.sh"
      fi
    fi
  done
fi

# --- openHAB Cloud ----------------------------------------------------------
# Nur Hinweis, kein Fehler: das Secret entsteht erst, wenn das Cloud-Addon
# das erste Mal laeuft - die Installation kann einige Minuten dauern.
if [ "$INSTALL_CLOUD" = "1" ]; then
  if [ -f "$OPENHAB_USERDATA/openhabcloud/secret" ]; then
    log "openHAB Cloud eingerichtet (Secret vorhanden)."
  else
    warn "openHAB Cloud: Secret noch nicht vorhanden - Addon noch nicht fertig"
    warn "installiert? Spaeter ausfuehren: sudo $GW_SETUP_DIR/07-openhab-cloud.sh"
  fi
fi

# --- WireGuard-Fernwartung --------------------------------------------------
if [ "$INSTALL_WIREGUARD" = "1" ] && command -v wg >/dev/null 2>&1; then
  hs="$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2; exit}')"
  if [ -n "$hs" ] && [ "$hs" -gt 0 ]; then
    log "WireGuard-Tunnel steht (letzter Handshake: $(date -d "@$hs" '+%F %T' 2>/dev/null || echo "$hs"))."
  else
    warn "WireGuard: noch kein Handshake - der Peer wird am Server automatisch eingetragen (bis zu 1 Minute)."
  fi
fi

# --- Netzwerk-Watchdog ------------------------------------------------------
if [ "$INSTALL_WATCHDOG" = "1" ]; then
  for f in "$OPENHAB_CONF/automation/js/stromkreis_watchdog.js" \
           "$OPENHAB_CONF/scripts/stromkreis_rediscover.sh" \
           "$OPENHAB_USERDATA/stromkreis/api_token"; do
    [ -f "$f" ] && log "vorhanden: $f" || fail "fehlt: $f"
  done

  if command -v curl >/dev/null 2>&1 && [ -n "$OH_API_TOKEN" ]; then
    status_json="$(curl -s -m 10 -H "Authorization: Bearer $OH_API_TOKEN" \
      "http://127.0.0.1:8080/rest/things/$INVERTER_HOST_THING_UID/status" || true)"
    if printf '%s' "$status_json" | grep -q '"status"'; then
      log "Watchdog-Bridge $INVERTER_HOST_THING_UID: $(printf '%s' "$status_json" | grep -o '"status"[[:space:]]*:[[:space:]]*"[A-Z]*"' | head -n1 | sed -e 's/.*"\([A-Z]*\)"/\1/')"
    else
      fail "Bridge-Status per REST nicht abrufbar - Token oder Thing-UID pruefen."
    fi
  fi

  serial_file="$OPENHAB_USERDATA/stromkreis/inverter_serial"
  if [ -f "$serial_file" ]; then
    log "Gemerkte Seriennummer(n): $(tr '\n' ' ' < "$serial_file")"
  else
    warn "Noch keine Seriennummer gemerkt - passiert automatisch, sobald das Thing ONLINE ist."
  fi
fi

# --- Parametrisierung -------------------------------------------------------
# Kein @GW_...@-Platzhalter darf in den installierten Regeln uebrig sein.
leftover="$(grep -ho '@GW_[A-Z_][A-Z_]*@' "$OPENHAB_CONF"/automation/js/stromkreis_*.js 2>/dev/null | sort -u | tr '\n' ' ' || true)"
if [ -n "$leftover" ]; then
  fail "Unersetzte Platzhalter in den installierten Regeln: ${leftover}- 04-install-rules.sh erneut ausfuehren."
else
  log "Alle Platzhalter in den installierten Regeln sind ersetzt."
fi

# Die Thing-UID-Pruefung gilt nur, wenn die Quelle sie ueberhaupt verwendet -
# ein Adapter, der ueber Items steuert (z. B. Modbus), enthaelt keine UID.
if [ "$GW_CONTROL_MODE" = "adapter" ]; then
  control_src="$GW_SCRIPT_DIR/$INVERTER_ADAPTER_SCRIPT"
else
  control_src="$GW_SCRIPT_DIR/$INVERTER_CONTROL_SCRIPT"
fi
if grep -q '@GW_THING_UID@' "$control_src" 2>/dev/null; then
  if grep -q "$INVERTER_THING_UID" "$OPENHAB_CONF/automation/js/stromkreis_battery_control.js" 2>/dev/null; then
    log "Thing-UID korrekt eingesetzt: $INVERTER_THING_UID"
  else
    fail "Thing-UID '$INVERTER_THING_UID' steht nicht in stromkreis_battery_control.js."
  fi
fi

# --- Wechselrichter-spezifische Pruefungen ----------------------------------
if type inverter_verify >/dev/null 2>&1; then
  if inverter_verify; then
    log "Wechselrichter-Pruefung (inverter_verify) OK."
  else
    fail "Wechselrichter-Pruefung (inverter_verify) meldet Probleme - siehe oben."
  fi
fi

# --- API --------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  for path in "/api/gateway/wolken/v1" "/api/gateway/crossover/v1"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json'       -d "{\"token\":$(json_str "${STROMKREIS_SITE_TOKEN:-}")}" "${STROMKREIS_BASE_URL}${path}" || true)"
    case "$code" in
      200) log "API OK: ${path} (HTTP $code)" ;;
      404) warn "API liefert keine Daten: ${path} (HTTP $code) - fuer diesen Tag oder diese Woche liegen noch keine Werte vor." ;;
      401) fail "API lehnt den Anlagen-Token ab: ${path} (HTTP $code)" ;;
      *)   fail "API nicht erreichbar: ${path} (HTTP $code)" ;;
    esac
  done
fi

# --- Logs -------------------------------------------------------------------
logfile="$OPENHAB_LOGDIR/openhab.log"
if [ -r "$logfile" ]; then
  echo
  log "Letzte [Stromkreis]-Meldungen aus $logfile:"
  grep -F '[Stromkreis]' "$logfile" | tail -n 20 || log "(noch keine - die Regeln laufen zeitgesteuert)"
  echo
  if grep -F '[Stromkreis]' "$logfile" >/dev/null 2>&1; then
    log "Die Regeln haben bereits geloggt."
  else
    warn "Noch keine [Stromkreis]-Meldungen. Regeln laufen zeitgesteuert - abwarten oder in der Main UI unter Rules manuell starten."
  fi
else
  warn "Logdatei nicht lesbar: $logfile (ggf. mit sudo ausfuehren)"
fi

if [ "$problems" -eq 0 ]; then
  log "Verify OK."
else
  warn "Verify abgeschlossen mit $problems Problem(en)."
  exit 1
fi
