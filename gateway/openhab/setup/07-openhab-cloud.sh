#!/usr/bin/env bash
# ============================================================================
# 07 - openHAB Cloud (Stromkreis-Instanz). Zwei Betriebsarten:
#
# Provisioniert (CLOUD_UUID/CLOUD_SECRET von der Plattform, Normalfall):
# schreibt UUID und Secret nach userdata/uuid bzw. userdata/openhabcloud/
# secret und startet openHAB bei einer Aenderung neu (die UUID wird nur
# beim Start gelesen). Das Cloud-Konto der Anlage legt die Plattform an;
# die Zugangsdaten stehen auf der Anlagen-Detailseite.
#
# Klassisch (ohne Werte von der Plattform): zeigt UUID und Secret fuer die
# manuelle Registrierung auf der Stromkreis-Cloud (CLOUD_BASE_URL) nur an.
#
# Das Addon 'openhabcloud' traegt 02-install-addons.sh in addons.cfg ein.
# Beim ersten Start erzeugt es das Secret unter
#   /var/lib/openhab/openhabcloud/secret
# Die UUID der Installation legt openHAB selbst beim ersten Boot an:
#   /var/lib/openhab/uuid
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
require_openhab
load_config

if [ "$INSTALL_CLOUD" != "1" ]; then
  log "INSTALL_CLOUD=0 - openHAB Cloud uebersprungen."
  exit 0
fi

uuid_file="$OPENHAB_USERDATA/uuid"
secret_file="$OPENHAB_USERDATA/openhabcloud/secret"

# --- Provisioniert: Identitaet von der Plattform setzen ----------------------
# Die Plattform erzeugt UUID und Secret und legt das Cloud-Konto an, bevor
# der Pi das erste Mal bootet. openHAB liest die UUID nur beim Start (daher
# Neustart, wenn sie sich aendert); das Cloud-Addon legt das Secret nur an,
# wenn die Datei fehlt - unsere gilt also, sobald das Addon startet
# (02-install-addons.sh laeuft danach).
if [ -n "$CLOUD_UUID" ] && [ -n "$CLOUD_SECRET" ]; then
  changed=0
  current_uuid="$( [ -f "$uuid_file" ] && tr -d '[:space:]' < "$uuid_file" || true )"
  if [ "$current_uuid" != "$CLOUD_UUID" ]; then
    printf '%s' "$CLOUD_UUID" > "$uuid_file"
    chown "$OPENHAB_USER:$OPENHAB_GROUP" "$uuid_file"; chmod 600 "$uuid_file"
    log "openHAB-UUID gesetzt: $CLOUD_UUID (war: ${current_uuid:-keine})"
    changed=1
  else
    log "openHAB-UUID bereits $CLOUD_UUID."
  fi
  current_secret="$( [ -f "$secret_file" ] && tr -d '[:space:]' < "$secret_file" || true )"
  if [ "$current_secret" != "$CLOUD_SECRET" ]; then
    mkdir -p "$(dirname "$secret_file")"
    (umask 077; printf '%s' "$CLOUD_SECRET" > "$secret_file")
    chown -R "$OPENHAB_USER:$OPENHAB_GROUP" "$(dirname "$secret_file")"
    log "Cloud-Secret gesetzt."
    [ -n "$current_secret" ] && changed=1
  else
    log "Cloud-Secret bereits gesetzt."
  fi
  if [ "$changed" = "1" ] && systemctl is-active --quiet openhab.service 2>/dev/null; then
    openhab_restart
    wait_for_openhab_rest 600 || warn "openHAB antwortet nach dem Neustart noch nicht."
  fi
  log "Cloud-Identitaet gesetzt - das Konto ($CLOUD_BASE_URL) legt die Plattform an;"
  log "die Anlage erscheint dort als Online, sobald das Cloud-Addon laeuft."
  exit 0
fi

# --- Klassisch: UUID und Secret nur anzeigen ---------------------------------
[ -f "$uuid_file" ] || die "UUID-Datei fehlt: $uuid_file - openHAB schon einmal gestartet?"
uuid="$(tr -d '[:space:]' < "$uuid_file")"
[ -n "$uuid" ] || die "UUID-Datei ist leer: $uuid_file"

# Das Secret entsteht erst, wenn das Cloud-Addon das erste Mal laeuft.
if [ ! -f "$secret_file" ]; then
  log "Warte auf das openHAB-Cloud-Secret ($secret_file) ..."
  log "Das Addon wird gerade installiert - das kann einige Minuten dauern."
  waited=0
  while [ ! -f "$secret_file" ] && [ "$waited" -lt 300 ]; do
    sleep 5
    waited=$((waited + 5))
  done
fi
if [ ! -f "$secret_file" ]; then
  warn "Secret nach 5 Minuten nicht gefunden: $secret_file"
  warn "Addon noch nicht fertig installiert? Fortschritt: tail -f $OPENHAB_LOGDIR/openhab.log"
  warn "Danach dieses Skript erneut ausfuehren: sudo $GW_SETUP_DIR/07-openhab-cloud.sh"
  exit 1
fi
secret="$(tr -d '[:space:]' < "$secret_file")"
[ -n "$secret" ] || die "Secret-Datei ist leer: $secret_file"

cat <<ANLEITUNG
[Stromkreis]
[Stromkreis] ===========================================================
[Stromkreis]  openHAB Cloud - Registrierung auf $CLOUD_BASE_URL
[Stromkreis] ===========================================================
[Stromkreis]
[Stromkreis]   UUID   : ${uuid}
[Stromkreis]   Secret : ${secret}
[Stromkreis]
[Stromkreis] Konto auf $CLOUD_BASE_URL anlegen und dabei UUID und Secret
[Stromkreis] eintragen; danach ist die Main UI von unterwegs erreichbar
[Stromkreis] (openHAB-App mit $CLOUD_BASE_URL als Remote-URL).
[Stromkreis]
ANLEITUNG
