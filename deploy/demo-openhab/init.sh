#!/usr/bin/env bash
# ============================================================================
# Demo-openHAB fuer die App-Pruefung (Seite /review): Einrichtung vor dem
# Start. Wird vom Entrypoint des openHAB-Images als /etc/cont-init.d/*.sh
# GESOURCT (als root, unter set -eux -o pipefail und IFS=Newline/Tab), bevor
# openHAB als Benutzer openhab startet - darum keine eigene Shebang-Logik,
# jeder Schritt idempotent und ohne Wortaufteilung an Leerzeichen.
#
# Macht, was auf einem Gateway 02/03/05/07 machen, nur ohne Wechselrichter:
#   - Cloud-Identitaet (userdata/uuid, userdata/openhabcloud/secret) aus
#     REVIEW_CLOUD_UUID / REVIEW_CLOUD_SECRET, Cloud-Connector auf die
#     stack-interne Cloud (CLOUD_INTERNAL_URL)
#   - Addons: jsscripting + openhabcloud
#   - Items (ohne Channels) und die Simulations-Regel aus /stromkreis
#   - Main-UI-Seiten des Profils fronius-symo (page-*.json aus dem
#     Gateway-Paket stromkreis-gateway.tgz) direkt in die JSONDB
#   - Admin-Konto im Hintergrund, sobald die Karaf-Konsole erreichbar ist
#     (ensure-admin.sh) - ohne Admin zeigt die Main UI den
#     Einrichtungsassistenten, und der Cloud-Benutzer koennte sich zum
#     Administrator machen.
# ============================================================================

sk_src=/stromkreis
sk_conf="${OPENHAB_CONF}"
sk_userdata="${OPENHAB_USERDATA}"
sk_log() { echo "[stromkreis-demo] $*"; }

if [ -z "${REVIEW_CLOUD_UUID:-}" ] || [ -z "${REVIEW_CLOUD_SECRET:-}" ]; then
  sk_log "REVIEW_CLOUD_UUID/REVIEW_CLOUD_SECRET fehlen - Cloud-Verbindung wird nicht eingerichtet."
fi

# --- Cloud-Identitaet --------------------------------------------------------
if [ -n "${REVIEW_CLOUD_UUID:-}" ] && [ -n "${REVIEW_CLOUD_SECRET:-}" ]; then
  mkdir -p "${sk_userdata}/openhabcloud"
  printf '%s' "${REVIEW_CLOUD_UUID}" > "${sk_userdata}/uuid"
  printf '%s' "${REVIEW_CLOUD_SECRET}" > "${sk_userdata}/openhabcloud/secret"
  chmod 600 "${sk_userdata}/uuid" "${sk_userdata}/openhabcloud/secret"
  mkdir -p "${sk_conf}/services"
  cat > "${sk_conf}/services/openhabcloud.cfg" <<EOF
# GENERIERT von deploy/demo-openhab/init.sh
baseURL=${CLOUD_INTERNAL_URL:-http://cloud-app:3000/}
mode=remote
expose=
EOF
  sk_log "Cloud-Identitaet gesetzt (UUID ${REVIEW_CLOUD_UUID})."
fi

# --- Addons -----------------------------------------------------------------
mkdir -p "${sk_conf}/services"
cat > "${sk_conf}/services/addons.cfg" <<'EOF'
# GENERIERT von deploy/demo-openhab/init.sh
package = minimal
ui = basic
automation = jsscripting
misc = openhabcloud
EOF

# --- Items und Simulations-Regel ----------------------------------------------
mkdir -p "${sk_conf}/items" "${sk_conf}/automation/js"
cp "${sk_src}/stromkreis-demo.items" "${sk_conf}/items/stromkreis-demo.items"
cp "${sk_src}/stromkreis-demo.js" "${sk_conf}/automation/js/stromkreis-demo.js"

# --- Main-UI-Seiten in die JSONDB ---------------------------------------------
# Format wie von openHAB selbst geschrieben: { "<uid>": { "class":
# "org.openhab.core.ui.components.RootUIComponent", "value": <Seite> }, ... }.
# Die Seiten kommen als page-<uid>.json (build-dist.sh); Platzhalter wie auf
# dem Gateway (05-install-overview.sh): die Items heissen hier genau wie
# die Platzhalter, nur die Begruessung wird ersetzt.
# Die Seiten stecken im Gateway-Paket (build-dist.sh erzeugt sie nur fuer
# das Paket und raeumt sie danach weg), daher hier aus dem Paket entpacken.
sk_tgz=/stromkreis-dist/stromkreis-gateway.tgz
sk_pages_dir="$(mktemp -d)"
if [ -f "${sk_tgz}" ]; then
  tar -xzf "${sk_tgz}" -C "${sk_pages_dir}" --strip-components=3 --wildcards 'openhab/inverters/fronius-symo/page-*.json' || sk_log "Seiten konnten nicht aus ${sk_tgz} entpackt werden."
else
  sk_log "Gateway-Paket ${sk_tgz} fehlt (deploy.sh baut es)."
fi
sk_jsondb="${sk_userdata}/jsondb"
mkdir -p "${sk_jsondb}"
sk_page_files="$(find "${sk_pages_dir}" -maxdepth 1 -name 'page-*.json' 2>/dev/null | sort || true)"
if [ -n "${sk_page_files}" ]; then
  sk_ts="$(date '+%b %d, %Y, %I:%M:%S %p')"
  sk_out="${sk_jsondb}/uicomponents_ui_page.json"
  sk_tmp="${sk_out}.tmp"
  sk_first=1
  printf '{\n' > "${sk_tmp}"
  for sk_file in ${sk_page_files}; do
    sk_uid="$(basename "${sk_file}")"; sk_uid="${sk_uid#page-}"; sk_uid="${sk_uid%.json}"
    [ "${sk_first}" = 1 ] || printf ',\n' >> "${sk_tmp}"
    sk_first=0
    printf '  "%s": {\n    "class": "org.openhab.core.ui.components.RootUIComponent",\n    "value": ' "${sk_uid}" >> "${sk_tmp}"
    # Erste Zeile "{" um den Zeitstempel ergaenzen, Begruessung setzen.
    sed -e "1s/^{/{ \"timestamp\": \"${sk_ts}\",/" \
        -e 's/HALLOSKGREETING/Hallo Demo/g' "${sk_file}" >> "${sk_tmp}"
    printf '\n  }' >> "${sk_tmp}"
  done
  printf '\n}\n' >> "${sk_tmp}"
  mv "${sk_tmp}" "${sk_out}"
  sk_log "Main-UI-Seiten geschrieben: $(echo "${sk_page_files}" | wc -l) Seiten."
else
  sk_log "Keine page-*.json im Gateway-Paket - Main UI bleibt ohne Stromkreis-Seiten."
fi
rm -rf "${sk_pages_dir}"

chown -R openhab:openhab "${sk_conf}" "${sk_userdata}"

# --- Admin-Konto im Hintergrund ------------------------------------------------
mkdir -p "${sk_userdata}/stromkreis" "${OPENHAB_LOGDIR}"
setsid nohup bash "${sk_src}/ensure-admin.sh" >> "${OPENHAB_LOGDIR}/stromkreis-demo-admin.log" 2>&1 < /dev/null &
sk_log "Einrichtung abgeschlossen, Admin-Konto folgt nach dem Start (stromkreis-demo-admin.log)."
