#!/usr/bin/env bash
# ============================================================================
# 04 - Regeln: verpackt die Stromkreis-Skripte als zeitgesteuerte JS-Regeln.
#
# Die Skripte unter ../eeg-api, ../control und ../inverters sind reine
# Skriptkoerper, wie sie in der Main UI als "Script Action" eingefuegt
# werden. Fuer den dateibasierten Betrieb werden sie hier in
# rules.JSRule(...) mit einem Cron-Trigger eingebettet und dabei
# anlagenspezifisch parametrisiert. Die Batteriesteuerung besteht aus dem
# Wechselrichter-Adapter des Profils gefolgt vom gemeinsamen Kern
# (control/core.js) im selben Regel-Body.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
require_openhab
load_config

# --- Status-Push ------------------------------------------------------------
# Jedes Stromkreis-Gateway ist provisioniert und hat seinen Anlagen-Token in
# der gateway.conf; der Status-Push ist Standard. Ohne Token (Sonderfall,
# z. B. manuell angelegte Konfiguration) bleibt er aus.
INSTALL_STATUS_PUSH="${INSTALL_STATUS_PUSH:-1}"
STROMKREIS_ANLAGE_NAME="${STROMKREIS_ANLAGE_NAME:-}"
STROMKREIS_SITE_TOKEN="${STROMKREIS_SITE_TOKEN:-}"
CRON_STATUS="${CRON_STATUS:-0 * * * * ?}"
if [ "$INSTALL_STATUS_PUSH" = "1" ] && [ -z "$STROMKREIS_SITE_TOKEN" ]; then
  warn "Kein Anlagen-Token in der gateway.conf - Status-Push bleibt aus."
  INSTALL_STATUS_PUSH=0
fi

if [ "$INSTALL_STATUS_PUSH" = "1" ] && [ -z "$STROMKREIS_ANLAGE_NAME" ]; then
  STROMKREIS_ANLAGE_NAME="$(hostname)"
fi

js_dir="$OPENHAB_CONF/automation/js"
mkdir -p "$js_dir"
chown "$OPENHAB_USER:$OPENHAB_GROUP" "$js_dir" 2>/dev/null || true

# Sonderzeichen fuer die rechte Seite eines sed-Ausdrucks entschaerfen.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# --- Gateway-Paketversion fuer den Status-Push ----------------------------------
# build-dist.sh legt eine BUILD-INFO ins Paket (Build-Datum, Commit); daraus
# wird der kompakte Stand "YYYY-MM-DD (commit)", den die Anlage mitmeldet.
# Bei einer Installation direkt aus dem Repository (Entwicklung) gibt es
# keine BUILD-INFO - dann bleibt der Stand unbekannt.
gw_version="unbekannt"
if [ -f "$GW_SCRIPT_DIR/BUILD-INFO" ]; then
  build_date="$(sed -n 's/^gebaut am: \([0-9-]*\).*/\1/p' "$GW_SCRIPT_DIR/BUILD-INFO")"
  gw_version="${build_date:-unbekannt}"
fi

api_base_esc="$(sed_escape "$STROMKREIS_BASE_URL")"
thing_uid_esc="$(sed_escape "$INVERTER_THING_UID")"
soc_item_esc="$(sed_escape "$SOC_ITEM")"
battery_power_item_esc="$(sed_escape "$BATTERY_POWER_ITEM")"
grid_power_item_esc="$(sed_escape "$GRID_POWER_ITEM")"
pv_power_item_esc="$(sed_escape "$PV_POWER_ITEM")"
anlage_name_esc="$(sed_escape "$STROMKREIS_ANLAGE_NAME")"
status_token_esc="$(sed_escape "$STROMKREIS_SITE_TOKEN")"
inverter_type_esc="$(sed_escape "$INVERTER_PROFILE")"
logdir_esc="$(sed_escape "$OPENHAB_LOGDIR")"
gw_version_esc="$(sed_escape "$gw_version")"

# Suchmuster aus dem Wechselrichter-Profil (linke Seite eines sed-Ausdrucks).
soc_placeholder_pat="$(printf '%s' "$INVERTER_SOC_PLACEHOLDER" | sed -e 's/[][\.*^$|]/\\&/g')"

# Skriptkoerper einlesen und anlagenspezifische Werte einsetzen. Neben den
# gewachsenen Mustern (URL, SoC-Platzhalter des Profils) werden die
# expliziten @...@-Platzhalter ersetzt. Skripte referenzieren Thing-UIDs
# ausschliesslich ueber @GW_THING_UID@ - ein frueherer sed, der jedes
# Literal mit dem Thing-Praefix ersetzte, wuerde Skripte mit mehreren
# Thing-UIDs (z. B. einem Modbus-Baum) auf eine einzige UID kollabieren.
render_payload() {
  sed -e "s|https://stromkreis\.net|${api_base_esc}|g" \
      -e "s|${soc_placeholder_pat}|${soc_item_esc}|g" \
      -e "s|@GW_THING_UID@|${thing_uid_esc}|g" \
      -e "s|@GW_SOC_ITEM@|${soc_item_esc}|g" \
      -e "s|@GW_BATTERY_POWER_ITEM@|${battery_power_item_esc}|g" \
      -e "s|@GW_GRID_POWER_ITEM@|${grid_power_item_esc}|g" \
      -e "s|@GW_PV_POWER_ITEM@|${pv_power_item_esc}|g" \
      -e "s|@GW_ANLAGE_NAME@|${anlage_name_esc}|g" \
      -e "s|@GW_STATUS_TOKEN@|${status_token_esc}|g" \
      -e "s|@GW_INVERTER_PROFILE@|${inverter_type_esc}|g" \
      -e "s|@GW_LOG_DIR@|${logdir_esc}|g" \
      -e "s|@GW_PAKET_VERSION@|${gw_version_esc}|g" \
      -e "s|@GW_UPDATE_FLAG@|$(sed_escape "$GW_UPDATE_FLAG")|g" \
      "$1"
}

# Erzeugt eine Regeldatei aus einem Skriptkoerper.
#   $1 Quelldatei  $2 Zieldatei  $3 Regel-ID  $4 Name  $5 Beschreibung  $6 Cron
#   $7 (optional) abweichende Quellenangabe im Kopfkommentar
generate_rule() {
  local src="$1" target="$2" rule_id="$3" name="$4" desc="$5" cron="$6"
  local src_display="${7:-$src}"

  [ -f "$src" ] || die "Quellskript fehlt: $src"

  {
    echo "// ==========================================================================="
    echo "// GENERIERT von 04-install-rules.sh - nicht direkt bearbeiten."
    echo "// Quelle: ${src_display}"
    echo "// Aenderungen im Repository vornehmen und das Setup erneut ausfuehren."
    echo "// ==========================================================================="
    echo "rules.JSRule({"
    echo "  id: '${rule_id}',"
    echo "  name: '${name}',"
    echo "  description: '${desc}',"
    echo "  tags: ['Stromkreis'],"
    echo "  triggers: [triggers.GenericCronTrigger('${cron}')],"
    echo "  execute: (event) => {"
    render_payload "$src"
    echo "  }"
    echo "});"
  } | install_file "$target"
}

generate_rule \
  "$GW_SCRIPT_DIR/api/cloud_forecast.js" \
  "$js_dir/stromkreis_cloud_forecast.js" \
  "stromkreis_cloud_forecast" \
  "Stromkreis - Wolkenvorschau abholen" \
  "Holt die Bewoelkungsvorhersage von der Plattform" \
  "$CRON_CLOUD"

generate_rule \
  "$GW_SCRIPT_DIR/api/crossover.js" \
  "$js_dir/stromkreis_crossover.js" \
  "stromkreis_crossover" \
  "Stromkreis - Crossover-Zeiten abholen" \
  "Holt Start- und Endzeit des Crossover-Fensters von der Plattform" \
  "$CRON_CROSSOVER"

generate_rule \
  "$GW_SCRIPT_DIR/api/ladefenster.js" \
  "$js_dir/stromkreis_ladesperre.js" \
  "stromkreis_ladesperre" \
  "Stromkreis - Ladesperre-Fenster abholen" \
  "Holt das Ladesperre-Fenster aus der Tagesprognose der Plattform-API" \
  "$CRON_LADESPERRE"

# Batteriesteuerung: im Adapter-Modus werden der Wechselrichter-Adapter des
# Profils und der gemeinsame Kern (control/core.js) in denselben Regel-Body
# gesetzt - der Adapter definiert gwReset/gwPreventCharge/gwForceDischarge,
# der Kern ruft sie auf. Legacy-Profile liefern weiterhin ein einzelnes,
# eigenstaendiges Steuerungsskript.
if [ "$GW_CONTROL_MODE" = "adapter" ]; then
  adapter_src="$GW_SCRIPT_DIR/$INVERTER_ADAPTER_SCRIPT"
  core_src="$GW_SCRIPT_DIR/control/core.js"
  [ -f "$adapter_src" ] || die "Adapter-Skript fehlt: $adapter_src"
  [ -f "$core_src" ] || die "Steuerungskern fehlt: $core_src"

  control_src="$(mktemp)"
  {
    echo "// --- Adapter (${INVERTER_PROFILE}): ${INVERTER_ADAPTER_SCRIPT} ---------------"
    cat "$adapter_src"
    echo ""
    echo "// --- Kern: control/core.js ------------------------------------------------"
    cat "$core_src"
  } > "$control_src"

  generate_rule \
    "$control_src" \
    "$js_dir/stromkreis_battery_control.js" \
    "stromkreis_battery_control" \
    "Stromkreis - Batteriesteuerung (${INVERTER_PROFILE})" \
    "Ladesperre am Vormittag und forcierte Entladung in der Nacht" \
    "$CRON_BATTERY" \
    "${INVERTER_ADAPTER_SCRIPT} + control/core.js"
  rm -f "$control_src"
else
  generate_rule \
    "$GW_SCRIPT_DIR/$INVERTER_CONTROL_SCRIPT" \
    "$js_dir/stromkreis_battery_control.js" \
    "stromkreis_battery_control" \
    "Stromkreis - Batteriesteuerung (${INVERTER_PROFILE})" \
    "Ladesperre am Vormittag und forcierte Entladung in der Nacht" \
    "$CRON_BATTERY"
fi

# --- Netzeinspeisung aus der Batterie (berechnet) ---------------------------
# Kleine Regel, die aus Batterie- und Netzleistung den Anteil der Entladung
# berechnet, der tatsaechlich ins Netz fliesst (Stromkreis_BATTERIE_NETZEINSPEISUNG,
# Karte auf der Overview-Seite). Anders als die Cron-Regeln laeuft sie bei
# jeder Aenderung der beiden Quell-Items. Ohne konfigurierte Items entfaellt
# sie; das Ziel-Item bleibt dann NULL und die Karte zeigt "-".
if [ -n "$BATTERY_POWER_ITEM" ] && [ -n "$GRID_POWER_ITEM" ]; then
  feedin_src="$GW_SCRIPT_DIR/control/netzeinspeisung.js"
  [ -f "$feedin_src" ] || die "Quellskript fehlt: $feedin_src"
  {
    echo "// ==========================================================================="
    echo "// GENERIERT von 04-install-rules.sh - nicht direkt bearbeiten."
    echo "// Quelle: control/netzeinspeisung.js"
    echo "// Aenderungen im Repository vornehmen und das Setup erneut ausfuehren."
    echo "// ==========================================================================="
    echo "rules.JSRule({"
    echo "  id: 'stromkreis_netzeinspeisung',"
    echo "  name: 'Stromkreis - Netzeinspeisung aus der Batterie berechnen',"
    echo "  description: 'Anteil der Batterie-Entladung, der ins Netz fliesst',"
    echo "  tags: ['Stromkreis'],"
    echo "  triggers: ["
    echo "    triggers.ItemStateChangeTrigger('${BATTERY_POWER_ITEM}'),"
    echo "    triggers.ItemStateChangeTrigger('${GRID_POWER_ITEM}')"
    echo "  ],"
    echo "  execute: (event) => {"
    render_payload "$feedin_src"
    echo "  }"
    echo "});"
  } | install_file "$js_dir/stromkreis_netzeinspeisung.js"
else
  log "Kein Batterie- oder Netzleistungs-Item konfiguriert - berechnete Netzeinspeisung uebersprungen."
fi

# --- Status-Push an das Betreiber-Dashboard ---------------------------------
if [ "$INSTALL_STATUS_PUSH" = "1" ]; then
  generate_rule \
    "$GW_SCRIPT_DIR/api/status_push.js" \
    "$js_dir/stromkreis_status_push.js" \
    "stromkreis_status_push" \
    "Stromkreis - Status an die Plattform melden" \
    "Meldet den Anlagenzustand an die Plattform (stromkreis.net)" \
    "$CRON_STATUS"

  # Der Status-Push meldet die Zahl ausstehender apt-Updates aus dem lokalen
  # Paket-Cache; damit die stimmt, muessen die Paketlisten regelmaessig
  # aktualisiert werden. Dafuer wird die Debian-eigene apt-daily-Mechanik
  # aktiviert (apt-daily.timer laeuft taeglich zu einem randomisierten
  # Zeitpunkt). Sicherheitsupdates spielt unattended-upgrades automatisch
  # ein (Debian-Standardkonfiguration: nur das Security-Archiv, kein
  # automatischer Reboot - openHAB und Pi-Firmware kommen aus anderen Repos
  # und bleiben damit Handarbeit). Alles Uebrige zeigt nur das Dashboard.
  apt_periodic="/etc/apt/apt.conf.d/02stromkreis-periodic"
  if command -v apt-get >/dev/null 2>&1 && [ -d /etc/apt/apt.conf.d ]; then
    # openHABian maskiert unattended-upgrades.service, damit waehrend der
    # Ersteinrichtung kein apt dazwischenfunkt. Die Updates selbst laufen
    # zwar ueber apt-daily-upgrade.timer, der Dienst laesst aber ein gerade
    # laufendes Update beim Herunterfahren fertig werden - fuer den
    # Regelbetrieb wird die Maskierung deshalb aufgehoben.
    systemctl unmask unattended-upgrades.service \
      apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
    if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
      log "Installiere unattended-upgrades (apt-get) ..."
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y -qq unattended-upgrades \
        || warn "unattended-upgrades konnte nicht installiert werden - Sicherheitsupdates bleiben Handarbeit."
    fi
    cat > "$apt_periodic" <<'EOF'
// GENERIERT von Stromkreis (04-install-rules.sh) - nicht direkt bearbeiten.
// Haelt die Paketlisten taeglich aktuell, damit der Status-Push die Zahl
// ausstehender apt-Updates korrekt an das Betreiber-Dashboard meldet, und
// laesst unattended-upgrades Sicherheitsupdates automatisch einspielen
// (Debian-Standard: nur das Security-Archiv, kein automatischer Reboot).
// Entfernt von purge-gateway.sh.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
    chmod 0644 "$apt_periodic"
    systemctl enable --now apt-daily.timer >/dev/null 2>&1 \
      || warn "apt-daily.timer konnte nicht aktiviert werden."
    systemctl enable --now apt-daily-upgrade.timer >/dev/null 2>&1 \
      || warn "apt-daily-upgrade.timer konnte nicht aktiviert werden."
    systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 \
      || warn "unattended-upgrades.service konnte nicht aktiviert werden."
    log "Taegliches apt-get update und automatische Sicherheitsupdates aktiviert ($apt_periodic)."
  else
    warn "apt-get nicht gefunden - taegliches apt-get update uebersprungen."
  fi
else
  log "INSTALL_STATUS_PUSH=0 - Status-Push uebersprungen."
fi

# --- Initialisierung der Konfigurations-Items -------------------------------
# Setzt Startwerte, solange ein Item noch NULL/UNDEF ist. Damit ist eine
# frische Installation sofort betriebsbereit; spaetere Aenderungen des
# Mitglieds bleiben unangetastet.
install_file "$js_dir/stromkreis_init.js" <<EOF
// ===========================================================================
// GENERIERT von 04-install-rules.sh - nicht direkt bearbeiten.
// Initialisiert die Konfigurations-Items mit Startwerten aus gateway.conf.
// ===========================================================================
rules.JSRule({
  id: 'stromkreis_init_defaults',
  name: 'Stromkreis - Konfigurations-Items initialisieren',
  description: 'Setzt Startwerte, solange ein Item noch NULL oder UNDEF ist',
  tags: ['Stromkreis'],
  triggers: [triggers.GenericCronTrigger('${CRON_INIT}')],
  execute: (event) => {
    var defaults = {
      'Stromkreis_Aktiv': '${DEFAULT_MAIN_SWITCH}',
      'Stromkreis_MIN_BATTERY_CHARGE': ${DEFAULT_MIN_BATTERY_CHARGE},
      'Minimale_Entladeleistung_Batterieeinspeisung': ${DEFAULT_MIN_DISCHARGE_W},
      'Maximale_Entladeleistung_Batterieeinspeisung': ${DEFAULT_MAX_DISCHARGE_W},
      'Stromkreis_LADESPERRE_AKTIV': '${DEFAULT_LADESPERRE_AKTIV}',
      'Stromkreis_LADESPERRE_WOLKEN_SCHWELLE': ${DEFAULT_WOLKEN_SCHWELLE},
      'Stromkreis_ENTLADUNG_AKTIV': '${DEFAULT_ENTLADUNG_AKTIV}',
      'Stromkreis_DYNAMISCHE_LEISTUNG': '${DEFAULT_DYNAMISCHE_LEISTUNG}',
      'Stromkreis_LADESPERRE_LOKAL': '${DEFAULT_LADESPERRE_LOKAL}',
      'Stromkreis_LADEREGELUNG': '${DEFAULT_LADEREGELUNG}',
      'Stromkreis_NETZLADESCHUTZ': '${DEFAULT_NETZLADESCHUTZ}',
      'Stromkreis_PAUSE_TAGE': 0
    };

    Object.keys(defaults).forEach(function (name) {
      var item = null;
      try {
        item = items.getItem(name);
      } catch (e) {
        item = null;
      }
      if (item === null || item === undefined) {
        console.error('[Stromkreis][Init] Item fehlt: ' + name);
        return;
      }
      var state = String(item.state);
      if (state === 'NULL' || state === 'UNDEF') {
        item.postUpdate(defaults[name]);
        console.log('[Stromkreis][Init] ' + name + ' initialisiert: ' + defaults[name]);
      }
    });
  }
});
EOF

# --- Pause herunterzaehlen --------------------------------------------------
# Die Unterseite "Stromkreis pausieren" setzt Stromkreis_PAUSE_TAGE; solange der Wert > 0
# ist, plant die Batteriesteuerung nichts. Diese Regel zaehlt ihn jede Nacht
# um 1 herunter - bei 0 laeuft die Steuerung von selbst wieder an.
install_file "$js_dir/stromkreis_pause.js" <<EOF
// ===========================================================================
// GENERIERT von 04-install-rules.sh - nicht direkt bearbeiten.
// Zaehlt die Pause (Stromkreis_PAUSE_TAGE) jede Nacht um 1 herunter.
// ===========================================================================
rules.JSRule({
  id: 'stromkreis_pause_countdown',
  name: 'Stromkreis - Pause herunterzaehlen',
  description: 'Zaehlt die verbleibenden Pausentage jede Nacht um 1 herunter',
  tags: ['Stromkreis'],
  triggers: [triggers.GenericCronTrigger('${CRON_PAUSE}')],
  execute: (event) => {
    var item = null;
    try {
      item = items.getItem('Stromkreis_PAUSE_TAGE');
    } catch (e) {
      item = null;
    }
    if (item === null || item === undefined) {
      console.error('[Stromkreis][Pause] Item fehlt: Stromkreis_PAUSE_TAGE');
      return;
    }
    var days = parseFloat(item.numericState);
    if (isNaN(days) || days <= 0) return;
    var next = Math.max(0, Math.round(days) - 1);
    item.postUpdate(next);
    console.log('[Stromkreis][Pause] Verbleibende Pausentage: ' + next + (next === 0 ? ' - Stromkreis arbeitet wieder' : ''));
  }
});
EOF

# --- Netzwerk-Watchdog ------------------------------------------------------
# Ueberwacht das Thing mit der Netzwerkadresse (bei Fronius die Bridge) und
# startet bei OFFLINE die Netzwerksuche aus dem Wechselrichter-Profil, die
# eine per DHCP geaenderte IP findet und per REST API in das Thing eintraegt.
install_watchdog() {
  local src="$GW_SCRIPT_DIR/$INVERTER_REDISCOVER_SCRIPT"
  local state_dir="$OPENHAB_USERDATA/stromkreis"
  local token_file="$state_dir/api_token"
  local script_target="$OPENHAB_CONF/scripts/stromkreis_rediscover.sh"

  if [ -z "$INVERTER_REDISCOVER_SCRIPT" ] || [ ! -f "$src" ]; then
    warn "Profil '$INVERTER_PROFILE' hat keine Netzwerksuche - Watchdog uebersprungen."
    return 0
  fi
  if [ -z "$INVERTER_HOST_THING_UID" ]; then
    warn "INVERTER_HOST_THING_UID fehlt in gateway.conf - Watchdog uebersprungen."
    return 0
  fi
  if [ "$OH_API_TOKEN" = "auto" ]; then
    ensure_api_token || true
  fi
  if [ -z "$OH_API_TOKEN" ] || [ "$OH_API_TOKEN" = "auto" ]; then
    warn "Kein brauchbares OH_API_TOKEN in gateway.conf - Watchdog uebersprungen."
    return 0
  fi

  # Arbeitsverzeichnis des Watchdogs (Token, gemerkte Seriennummer, Lock)
  mkdir -p "$state_dir"
  chown "$OPENHAB_USER:$OPENHAB_GROUP" "$state_dir" 2>/dev/null || true
  chmod 0700 "$state_dir"

  # Das Token gehoert nicht in eine weltlesbare Datei, daher nicht install_file.
  printf '%s\n' "$OH_API_TOKEN" > "$token_file"
  chown "$OPENHAB_USER:$OPENHAB_GROUP" "$token_file" 2>/dev/null || true
  chmod 0600 "$token_file"
  log "API-Token abgelegt: $token_file"

  sed -e "s|@GW_HOST_THING_UID@|$(sed_escape "$INVERTER_HOST_THING_UID")|g" \
      -e "s|@GW_HOST_PARAM@|$(sed_escape "$INVERTER_HOST_PARAM")|g" \
      -e "s|@GW_TOKEN_FILE@|$(sed_escape "$token_file")|g" \
      -e "s|@GW_STATE_DIR@|$(sed_escape "$state_dir")|g" \
      -e "s|@GW_COOLDOWN_MIN@|$(sed_escape "$WATCHDOG_COOLDOWN_MIN")|g" \
      "$src" | install_file "$script_target"
  chmod 0755 "$script_target"

  install_file "$js_dir/stromkreis_watchdog.js" <<EOF
// ===========================================================================
// GENERIERT von 04-install-rules.sh - nicht direkt bearbeiten.
// Quelle der Netzwerksuche: $INVERTER_REDISCOVER_SCRIPT
// Aenderungen im Repository vornehmen und das Setup erneut ausfuehren.
// ===========================================================================
rules.JSRule({
  id: 'stromkreis_inverter_watchdog',
  name: 'Stromkreis - Netzwerk-Watchdog (${INVERTER_PROFILE})',
  description: 'Findet den Wechselrichter nach einem IP-Wechsel im Netz wieder',
  tags: ['Stromkreis'],
  triggers: [
    triggers.ThingStatusChangeTrigger('${INVERTER_HOST_THING_UID}', 'OFFLINE'),
    triggers.GenericCronTrigger('${CRON_WATCHDOG}')
  ],
  execute: (event) => {
    // Das Skript prueft selbst Status, Abkuehlzeit und Identitaet -
    // im Normalbetrieb (Thing ONLINE) tut es nichts und gibt nichts aus.
    var out = actions.Exec.executeCommandLine(time.Duration.ofMinutes(5), '${script_target}');
    if (out) {
      String(out).split('\n').forEach(function (line) {
        if (line.trim().length > 0) { console.log(line); }
      });
    }
  }
});
EOF

  # Einmal sofort laufen lassen: prueft Token und REST-Zugriff und merkt sich
  # die Seriennummer des Wechselrichters, solange die Verbindung noch steht.
  if command -v runuser >/dev/null 2>&1; then
    log "Erster Watchdog-Lauf (prueft Token und merkt sich die Seriennummer) ..."
    runuser -u "$OPENHAB_USER" -- "$script_target" \
      | sed 's/^/[Stromkreis]   /' \
      || warn "Erster Watchdog-Lauf fehlgeschlagen - siehe Meldungen oben."
  fi
}

if [ "$INSTALL_WATCHDOG" = "1" ]; then
  install_watchdog
else
  log "INSTALL_WATCHDOG=0 - Netzwerk-Watchdog uebersprungen."
fi

log "Regeln installiert in $js_dir"
log "openHAB laedt Dateien in diesem Verzeichnis automatisch neu."

# --- Abhol-Regeln einmal sofort ausfuehren ------------------------------------
# Crossover (taeglich 04:05), Ladefenster (stuendlich :50) und Wolkenvorschau
# (stuendlich :40) liefern der Steuerung ihre Zeitfenster. Nach einer
# (Neu-)Installation sind die Items bis zum naechsten Cron-Lauf NULL - beim
# Crossover bis zu einem Tag lang, und ohne Crossover-Zeiten bleibt die
# Entladung aus ("Keine plausiblen Crossover-Zeiten"). Deshalb hier per REST
# anstossen, sobald openHAB die Regeldateien geladen hat.
run_rule_once() {
  local rule_id="$1" waited=0 code
  [ -n "${OH_API_TOKEN:-}" ] && [ "$OH_API_TOKEN" != "auto" ] || return 0
  while [ "$waited" -lt 90 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $OH_API_TOKEN" \
              "http://127.0.0.1:8080/rest/rules/$rule_id" || true)"
    [ "$code" = "200" ] && break
    sleep 5; waited=$((waited + 5))
  done
  if [ "$code" != "200" ]; then
    warn "Regel $rule_id nach 90 s nicht geladen - erster Lauf erfolgt per Cron."
    return 0
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H "Authorization: Bearer $OH_API_TOKEN" \
            "http://127.0.0.1:8080/rest/rules/$rule_id/runnow" || true)"
  if [ "$code" = "200" ]; then
    log "Regel $rule_id einmal ausgefuehrt."
  else
    warn "Regel $rule_id konnte nicht gestartet werden (HTTP $code) - erster Lauf erfolgt per Cron."
  fi
}
for rule_id in stromkreis_crossover stromkreis_ladesperre stromkreis_cloud_forecast; do
  run_rule_once "$rule_id"
done
