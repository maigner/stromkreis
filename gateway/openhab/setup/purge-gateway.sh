#!/usr/bin/env bash
# ============================================================================
# purge-gateway.sh - entfernt das Stromkreis Speichermanagement wieder komplett
#
# Setzt die Anlage in den Zustand "frisches openHABian + Admin-Konto"
# zurueck, z. B. um die Installation erneut zu testen oder eine Anlage
# ausser Betrieb zu nehmen. Entfernt in dieser Reihenfolge:
#
#   1. Main-UI-Seiten (Overview wird aus dem Backup wiederhergestellt)
#   2. Bridge- und Wechselrichter-Thing (REST)
#   3. API-Token 'stromkreis' und /var/lib/openhab/stromkreis
#   4. Regeln, Items, Persistence-Konfiguration und mapdb-Daten
#   5. addons.cfg (Backup von vor der Installation wird wiederhergestellt)
#   6. WireGuard-Tunnel und Schluessel
#   7. Konsolen-Passwort zurueck auf den openHAB-Standard (habopen)
#   8. /opt/stromkreis selbst
#
# NICHT angetastet: das openHAB-Admin-Konto, das Linux-Passwort, die
# Regionaleinstellungen (Zeitzone/Sprache) und die openHAB-Cloud-Identitaet
# (userdata/uuid, openhabcloud/secret) - eine Neuinstallation verwendet sie
# einfach wieder.
#
#   sudo /opt/stromkreis/openhab/setup/purge-gateway.sh
#   sudo STROMKREIS_ASSUME_YES=1 ...   # ohne Rueckfrage
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
require_openhab

# gateway.conf ist fuer den Purge hilfreich, aber nicht Pflicht.
if [ -f "$GATEWAY_CONF" ]; then
  load_config
else
  warn "gateway.conf fehlt - es wird mit Standardwerten aufgeraeumt."
  OH_API_TOKEN=""
  INVERTER_THING_UID=""
  INVERTER_HOST_THING_UID=""
fi

REST="http://127.0.0.1:8080/rest"

echo "[Stromkreis]"
echo "[Stromkreis] ==========================================================="
echo "[Stromkreis]  Purge: entfernt das Batteriemanagement vollstaendig"
echo "[Stromkreis] ==========================================================="
echo "[Stromkreis]"
echo "[Stromkreis] Things, Regeln, Items, Seiten, Token, WireGuard und"
echo "[Stromkreis] /opt/stromkreis werden geloescht. Admin-Konto, Linux-Passwort"
echo "[Stromkreis] und Zeitzone bleiben."
confirm "Wirklich alles entfernen?" || { log "Abgebrochen."; exit 0; }

auth_curl() { curl -s -H "Authorization: Bearer $OH_API_TOKEN" "$@"; }
have_token() { case "${OH_API_TOKEN:-}" in oh.*) return 0 ;; *) return 1 ;; esac; }

# --- 1. Main-UI-Seiten --------------------------------------------------------
if have_token; then
  for pagefile in "$GW_INVERTER_DIR/${INVERTER_PROFILE:-fronius}"/page-*.json; do
    [ -f "$pagefile" ] || continue
    uid="$(basename "$pagefile" .json)"; uid="${uid#page-}"
    if [ "$uid" = "overview" ]; then
      backup="$(ls -t /var/lib/openhab/stromkreis/overview.page.bak-*.json 2>/dev/null | head -n1 || true)"
      if [ -n "$backup" ]; then
        code="$(auth_curl -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
                  -d @"$backup" "$REST/ui/components/ui%3Apage/overview" || true)"
        log "Overview-Seite aus Backup wiederhergestellt (HTTP $code): $(basename "$backup")"
        continue
      fi
    fi
    code="$(auth_curl -o /dev/null -w '%{http_code}' -X DELETE "$REST/ui/components/ui%3Apage/$uid" || true)"
    case "$code" in
      200|204) log "Seite entfernt: $uid" ;;
      404)     log "Seite nicht vorhanden: $uid" ;;
      *)       warn "Seite '$uid' nicht entfernt (HTTP $code)." ;;
    esac
  done
else
  warn "Kein API-Token in gateway.conf - Main-UI-Seiten bleiben stehen (in der UI loeschen)."
fi

# --- 2. Things ----------------------------------------------------------------
if have_token; then
  # Profile mit eigenem Thing-Baum (inverter_things_json) liefern alle UIDs;
  # geloescht wird in umgekehrter Reihenfolge (Kinder vor ihren Bridges).
  # Die UIDs aus gateway.conf bleiben als Rueckfall und werden dedupliziert.
  purge_uids=""
  if type inverter_things_json >/dev/null 2>&1; then
    purge_uids="$(inverter_things_json 2>/dev/null | things_manifest_uids_reverse 2>/dev/null || true)"
  fi
  purge_uids="${purge_uids}
${INVERTER_THING_UID:-}
${INVERTER_HOST_THING_UID:-}"
  while IFS= read -r uid; do
    [ -n "$uid" ] || continue
    code="$(auth_curl -o /dev/null -w '%{http_code}' -X DELETE "$REST/things/$uid?force=true" || true)"
    case "$code" in
      200|202|204) log "Thing entfernt: $uid" ;;
      404)         log "Thing nicht vorhanden: $uid" ;;
      *)           warn "Thing '$uid' nicht entfernt (HTTP $code)." ;;
    esac
  done <<< "$(printf '%s\n' "$purge_uids" | awk 'NF && !seen[$0]++')"
else
  warn "Kein API-Token - Things bleiben stehen (Main UI -> Settings -> Things)."
fi

# --- 3. API-Token und Arbeitsverzeichnis ---------------------------------------
out="$(console_exec "openhab:users list" 2>/dev/null || true)"
admin_user="$(printf '%s\n' "$out" | grep -i 'administrator' | head -n1 | awk '{print $1}')"
if [ -n "$admin_user" ]; then
  console_exec "openhab:users rmApiToken $admin_user stromkreis" >/dev/null 2>&1 \
    && log "API-Token 'stromkreis' von '$admin_user' widerrufen." \
    || log "Kein API-Token 'stromkreis' zu widerrufen."
fi
rm -rf /var/lib/openhab/stromkreis && log "entfernt: /var/lib/openhab/stromkreis"

# --- 4. Regeln, Items, Persistence ---------------------------------------------
rm -f "$OPENHAB_CONF"/automation/js/stromkreis_*.js \
      "$OPENHAB_CONF"/scripts/stromkreis_rediscover.sh \
      "$OPENHAB_CONF"/items/stromkreis.items \
      "$OPENHAB_CONF"/persistence/mapdb.persist \
      "$OPENHAB_CONF"/persistence/rrd4j.persist
log "Regeln, Items und Persistence-Konfiguration entfernt."
# Taegliches apt-get update und automatische apt-Updates fuer den
# Status-Push (die apt-daily-Timer und das Paket unattended-upgrades sind
# Debian-Standard und bleiben installiert - ohne die Periodic-Eintraege
# tun sie nichts mehr, und ohne die 52er-Datei gilt wieder die
# Debian-Vorgabe: nur das Security-Archiv, kein automatischer Reboot).
rm -f /etc/apt/apt.conf.d/02stromkreis-periodic \
      /etc/apt/apt.conf.d/52stromkreis-unattended-upgrades \
  && log "entfernt: apt-Konfiguration (02stromkreis-periodic, 52stromkreis-unattended-upgrades) - automatische apt-Updates deaktiviert"
rm -rf /var/lib/openhab/persistence/mapdb /var/lib/openhab/persistence/rrd4j \
  && log "mapdb- und rrd4j-Daten entfernt."
# Der Standard-Dienst zeigt sonst auf das dann deinstallierte rrd4j.
if [ -f "$OPENHAB_CONF/services/runtime.cfg" ]; then
  sed -i '/^org\.openhab\.persistence:default=/d' "$OPENHAB_CONF/services/runtime.cfg" \
    && log "Standard-Persistence-Dienst aus runtime.cfg entfernt."
fi

# --- 5. addons.cfg -------------------------------------------------------------
oldest_bak="$(ls -tr "$OPENHAB_CONF"/services/addons.cfg.bak-* 2>/dev/null | head -n1 || true)"
if [ -n "$oldest_bak" ]; then
  mv "$oldest_bak" "$OPENHAB_CONF/services/addons.cfg"
  rm -f "$OPENHAB_CONF"/services/addons.cfg.bak-*
  log "addons.cfg aus dem aeltesten Backup wiederhergestellt - openHAB entfernt die Addons."
elif [ -f "$OPENHAB_CONF/services/addons.cfg" ]; then
  rm -f "$OPENHAB_CONF/services/addons.cfg"
  log "addons.cfg entfernt (war von der Installation angelegt)."
fi

# --- 5b. Selbst-Update ------------------------------------------------------------
if [ -f /etc/systemd/system/stromkreis-update.timer ]; then
  systemctl disable --now stromkreis-update.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/stromkreis-update.timer /etc/systemd/system/stromkreis-update.service /usr/local/sbin/stromkreis-update
  systemctl daemon-reload >/dev/null 2>&1 || true
  log "Selbst-Update entfernt (stromkreis-update.timer)."
fi

# --- 6. WireGuard ---------------------------------------------------------------
if [ -f /etc/wireguard/wg0.conf ] || [ -f /etc/wireguard/stromkreis-pi.key ]; then
  systemctl disable --now wg-quick@wg0 >/dev/null 2>&1 || true
  rm -f /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak-*         /etc/wireguard/stromkreis-pi.key /etc/wireguard/stromkreis-pi.pub
  log "WireGuard-Tunnel entfernt (Pakete bleiben installiert)."
  log "Der Peer am Server verschwindet, sobald die Anlage auf der Plattform geloescht ist."
fi

# --- 7. Konsolen-Passwort zurueck auf Standard -----------------------------------
up="$OPENHAB_USERDATA/etc/users.properties"
if [ -f "$up" ]; then
  stored="$(karaf_stored_password habopen)"
  sed -i -E "s|^([[:space:]]*openhab[[:space:]]*=[[:space:]]*)[^,]*|\1${stored}|" "$up"
  log "Karaf-Konsolen-Passwort zurueck auf den Standard (habopen)."
fi

# --- 8. Neustart und Selbstentfernung --------------------------------------------
log "openHAB wird neu gestartet, damit alles sauber verschwindet ..."
systemctl restart openhab.service || warn "Neustart fehlgeschlagen - bitte manuell."

rm -rf /opt/stromkreis
log "entfernt: /opt/stromkreis"

# Zero-Touch-Provisionierung: Marker von stromkreis-firstboot entfernen, damit ein
# erneuter Lauf (neuer Code vom Dashboard auf der Boot-Partition) wieder
# startet. Die Unit selbst bleibt; ohne stromkreis-provision.conf tut sie nichts.
rm -rf /var/lib/stromkreis /run/stromkreis-provision.env
log "entfernt: /var/lib/stromkreis (Provisionierungs-Marker)"

cat <<ENDE
[Stromkreis]
[Stromkreis] ===========================================================
[Stromkreis]  Purge abgeschlossen.
[Stromkreis] ===========================================================
[Stromkreis]
[Stromkreis] Uebrig geblieben (absichtlich): Admin-Konto der Main UI,
[Stromkreis] Linux-Passwort, Zeitzone/Region und die Cloud-Identitaet.
[Stromkreis]
[Stromkreis] Neuinstallation:
[Stromkreis]   curl -fsSL ${STROMKREIS_BASE_URL:-https://stromkreis.net}/gateway/install.sh -o install.sh
[Stromkreis]   sudo bash install.sh
[Stromkreis]
ENDE
