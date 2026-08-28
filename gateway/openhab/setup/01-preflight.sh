#!/usr/bin/env bash
# ============================================================================
# 01 - Preflight: prueft die Voraussetzungen, aendert nichts.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_openhab
load_config

problems=0
fail() { warn "$*"; problems=$((problems + 1)); }

# --- openHAB-Dienst ---------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet openhab.service; then
    log "openHAB-Dienst laeuft."
  else
    fail "openHAB-Dienst laeuft nicht (systemctl status openhab.service)."
  fi
else
  warn "systemctl nicht gefunden - Dienststatus nicht pruefbar."
fi

# --- Verzeichnisse ----------------------------------------------------------
for d in "$OPENHAB_CONF/items" "$OPENHAB_CONF/services" "$OPENHAB_CONF/automation"; do
  [ -d "$d" ] && log "vorhanden: $d" || log "wird angelegt: $d"
done

# --- Quellskripte -----------------------------------------------------------
control_sources=()
if [ "$GW_CONTROL_MODE" = "adapter" ]; then
  control_sources=("$GW_SCRIPT_DIR/$INVERTER_ADAPTER_SCRIPT" "$GW_SCRIPT_DIR/control/core.js")
else
  control_sources=("$GW_SCRIPT_DIR/$INVERTER_CONTROL_SCRIPT")
fi
for f in "$GW_SCRIPT_DIR/api/cloud_forecast.js" \
         "$GW_SCRIPT_DIR/api/crossover.js" \
         "$GW_SCRIPT_DIR/api/ladefenster.js" \
         "${control_sources[@]}"; do
  [ -f "$f" ] && log "gefunden: $f" || fail "Quellskript fehlt: $f"
done

# --- Erreichbarkeit der Plattform-API --------------------------------------
if command -v curl >/dev/null 2>&1; then
  for path in "/api/gateway/wolken/v1" "/api/gateway/crossover/v1" "/api/gateway/ladefenster/v1"; do
    # Alle Datenendpunkte sind mandantenbezogen und brauchen den
    # Anlagen-Token (POST). curl gibt bei Verbindungsfehlern selbst "000"
    # aus - daher nur abfangen, nicht zusaetzlich ausgeben.
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json'       -d "{\"token\":$(json_str "${STROMKREIS_SITE_TOKEN:-}")}" "${STROMKREIS_BASE_URL}${path}" || true)"
    case "$code" in
      200) log "API erreichbar: ${STROMKREIS_BASE_URL}${path} (HTTP $code)" ;;
      404) warn "API liefert keine Daten: ${path} (HTTP $code) - fuer diesen Tag oder diese Woche liegen noch keine Werte vor." ;;
      401) fail "API lehnt den Anlagen-Token ab: ${path} (HTTP $code)" ;;
      *)   fail "API nicht erreichbar: ${STROMKREIS_BASE_URL}${path} (HTTP $code)" ;;
    esac
  done
else
  warn "curl nicht installiert - API-Erreichbarkeit nicht pruefbar."
fi

# --- Wechselrichter-Thing ---------------------------------------------------
things_db="$OPENHAB_USERDATA/jsondb/org.openhab.core.thing.Thing.json"
if [ -f "$things_db" ]; then
  if grep -q "$INVERTER_THING_UID" "$things_db"; then
    log "Thing gefunden: $INVERTER_THING_UID"
  elif [ "$AUTO_CREATE_THING" = "1" ]; then
    log "Thing '$INVERTER_THING_UID' existiert noch nicht - legt 02b-install-things.sh an."
  else
    fail "Thing '$INVERTER_THING_UID' nicht in der JSONDB. Wechselrichter in der Main UI anlegen und den Assistenten erneut ausfuehren."
  fi
else
  warn "JSONDB nicht gefunden ($things_db) - Thing nicht pruefbar."
fi

# --- SoC-Item ---------------------------------------------------------------
items_db="$OPENHAB_USERDATA/jsondb/org.openhab.core.items.Item.json"
if [ -f "$items_db" ]; then
  if grep -q "\"$SOC_ITEM\"" "$items_db"; then
    log "Ladestands-Item gefunden: $SOC_ITEM"
  elif [ "$AUTO_CREATE_THING" = "1" ] \
       || grep -qE "[[:space:]]${SOC_ITEM}[[:space:]]" "$OPENHAB_CONF/items/stromkreis.items" 2>/dev/null; then
    log "Ladestands-Item '$SOC_ITEM' kommt aus stromkreis.items (automatische Einrichtung)."
  else
    fail "Ladestands-Item '$SOC_ITEM' nicht gefunden. Channel '${INVERTER_SOC_CHANNEL}' in der Main UI mit einem Item verknuepfen."
  fi

  # Kollision: von Stromkreis verwaltete Items duerfen nicht zusaetzlich in der
  # JSONDB (Main UI) existieren, sonst streiten sich Datei und UI.
  for item in Stromkreis_Aktiv \
              Stromkreis_Wolkenvorschau \
              Stromkreis_Wolkenvorschau_Zeit \
              Stromkreis_Crossover_Start \
              Stromkreis_Crossover_Ende \
              Stromkreis_Ladesperre_Start \
              Stromkreis_Ladesperre_Ende \
              Stromkreis_Ladesperre_Datum \
              Stromkreis_Ladesperre_Individuell \
              Stromkreis_Wolken_Stunden \
              Stromkreis_Ladefaktoren \
              Stromkreis_Entladestart \
              Stromkreis_MIN_BATTERY_CHARGE \
              Minimale_Entladeleistung_Batterieeinspeisung \
              Maximale_Entladeleistung_Batterieeinspeisung \
              Stromkreis_PAUSE_TAGE \
              Stromkreis_LADESPERRE_AKTIV \
              Stromkreis_LADESPERRE_WOLKEN_SCHWELLE \
              Stromkreis_ENTLADUNG_AKTIV \
              Stromkreis_DYNAMISCHE_LEISTUNG \
              Stromkreis_BATTERIE_KAPAZITAET \
              Stromkreis_KAPAZITAET_MESSUNG \
              Stromkreis_LADESPERRE_LOKAL \
              Stromkreis_LADELEISTUNG \
              Stromkreis_LADERATE_MESSUNG \
              Stromkreis_LADESPERRE_LOKAL_ENDE \
              Stromkreis_LADEREGELUNG \
              Stromkreis_LADEREGELUNG_SOLL \
              Stromkreis_LADEREGELUNG_STATUS \
              Stromkreis_RESTLADEZEIT \
              Stromkreis_NETZLADESCHUTZ \
              Stromkreis_NETZLADUNG \
              Stromkreis_NETZLADE_WAECHTER \
              Stromkreis_HAUSLAST \
              Stromkreis_HAUSLAST_MESSUNG \
              Stromkreis_NACHTBUDGET \
              Stromkreis_BATTERIE_NETZEINSPEISUNG \
              Stromkreis_BATTERIE_NETZEINSPEISUNG_KWH \
              Stromkreis_NETZEINSPEISUNG_ZAEHLER; do
    if grep -q "\"$item\"" "$items_db"; then
      fail "Item '$item' existiert bereits in der Main UI und wuerde mit $OPENHAB_CONF/items/stromkreis.items kollidieren - bitte in der UI loeschen."
    fi
  done

  # Bei der automatischen Einrichtung kommen auch die Batterie-Items aus
  # stromkreis.items - gleichnamige UI-Items wuerden genauso kollidieren. Profile
  # mit eigener Item-Liste (inverter_battery_items) koennen weitere Items
  # mitbringen (z. B. Modbus-Steuerregister); deren Namen stehen in der
  # zweiten Spalte der .items-Zeilen.
  if [ "$AUTO_CREATE_THING" = "1" ]; then
    battery_item_names="$SOC_ITEM
${BATTERY_POWER_ITEM:-}
${GRID_POWER_ITEM:-}"
    if type inverter_battery_items >/dev/null 2>&1; then
      battery_item_names="$battery_item_names
$(inverter_battery_items | awk '$1 ~ /^(Number|Switch|String|Dimmer|Contact|DateTime|Group)/ {print $2}')"
    fi
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      if grep -q "\"$item\"" "$items_db"; then
        fail "Item '$item' existiert bereits in der Main UI und wuerde mit $OPENHAB_CONF/items/stromkreis.items kollidieren - bitte in der UI loeschen."
      fi
    done <<< "$(printf '%s\n' "$battery_item_names" | sort -u)"
  fi
fi

# --- Netzwerk-Watchdog ------------------------------------------------------
if [ "$INSTALL_WATCHDOG" = "1" ]; then
  src="$GW_SCRIPT_DIR/${INVERTER_REDISCOVER_SCRIPT:-}"
  if [ -z "$INVERTER_REDISCOVER_SCRIPT" ] || [ ! -f "$src" ]; then
    fail "Netzwerksuche fehlt im Profil '$INVERTER_PROFILE': ${src}"
  else
    log "gefunden: $src"
  fi

  [ -n "$INVERTER_HOST_THING_UID" ] || fail "INVERTER_HOST_THING_UID fehlt in gateway.conf (Watchdog)."
  [ -n "$OH_API_TOKEN" ] || fail "OH_API_TOKEN fehlt in gateway.conf (Watchdog)."

  if [ -f "$things_db" ] && [ -n "$INVERTER_HOST_THING_UID" ]; then
    if grep -q "$INVERTER_HOST_THING_UID" "$things_db"; then
      log "Bridge-Thing gefunden: $INVERTER_HOST_THING_UID"
    elif [ "$AUTO_CREATE_THING" = "1" ]; then
      log "Bridge-Thing '$INVERTER_HOST_THING_UID' existiert noch nicht - legt 02b-install-things.sh an."
    else
      fail "Bridge-Thing '$INVERTER_HOST_THING_UID' nicht in der JSONDB."
    fi
  fi

  for cmd in ip flock xargs seq curl; do
    command -v "$cmd" >/dev/null 2>&1 || fail "Kommando fehlt fuer den Watchdog: $cmd"
  done

  # Token gegen die REST API pruefen (Thing-Endpunkte brauchen Admin-Rechte).
  if [ "$OH_API_TOKEN" = "auto" ]; then
    log "API-Token wird bei der Installation automatisch erzeugt - Pruefung uebersprungen."
  elif command -v curl >/dev/null 2>&1 && [ -n "$OH_API_TOKEN" ] && [ -n "$INVERTER_HOST_THING_UID" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      -H "Authorization: Bearer $OH_API_TOKEN" \
      "http://127.0.0.1:8080/rest/things/$INVERTER_HOST_THING_UID" || true)"
    case "$code" in
      200)     log "API-Token OK - Bridge-Thing per REST erreichbar." ;;
      401|403) fail "API-Token wird abgelehnt (HTTP $code) - Token eines Admin-Benutzers eintragen." ;;
      404)     fail "Bridge-Thing per REST nicht gefunden (HTTP 404): $INVERTER_HOST_THING_UID" ;;
      *)       warn "openHAB REST API nicht pruefbar (HTTP $code) - laeuft openHAB?" ;;
    esac
  fi
fi

# --- Main-UI-Seiten ---------------------------------------------------------
if [ "$INSTALL_OVERVIEW" = "1" ]; then
  ov="$GW_INVERTER_DIR/$INVERTER_PROFILE/page-overview.json"
  if [ -f "$ov" ]; then
    log "gefunden: $ov"
  else
    fail "Main-UI-Seiten fehlen: $ov - Paket mit aktuellem build-dist.sh gebaut?"
  fi
  [ -n "$OH_API_TOKEN" ] || fail "OH_API_TOKEN fehlt in gateway.conf (Overview-Seite)."

  if [ "$OH_API_TOKEN" = "auto" ]; then
    log "API-Token wird bei der Installation automatisch erzeugt - Pruefung uebersprungen."
  elif command -v curl >/dev/null 2>&1 && [ -n "$OH_API_TOKEN" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      -H "Authorization: Bearer $OH_API_TOKEN" \
      "http://127.0.0.1:8080/rest/ui/components/ui%3Apage" || true)"
    case "$code" in
      200)     log "API-Token OK - UI-Seiten per REST erreichbar." ;;
      401|403) fail "API-Token wird abgelehnt (HTTP $code) - Token eines Admin-Benutzers eintragen." ;;
      *)       warn "openHAB REST API nicht pruefbar (HTTP $code) - laeuft openHAB?" ;;
    esac
  fi
fi

# --- Ergebnis ---------------------------------------------------------------
if [ "$problems" -eq 0 ]; then
  log "Preflight OK - keine Probleme gefunden."
else
  warn "Preflight abgeschlossen mit $problems Problem(en) - siehe oben."
  exit 1
fi
