#!/usr/bin/env bash
# ============================================================================
# Legt im Demo-openHAB ein Admin-Konto an, sobald die Karaf-Konsole
# erreichbar ist (gestartet von init.sh im Hintergrund, laeuft als root).
# Gleiches Vorgehen wie console_exec/ensure_admin_user in
# gateway/openhab/setup/lib/common.sh: voruebergehend ein zufaelliges
# Konsolen-Passwort in users.properties, Kommando per stdin, Datei
# wiederherstellen. Das Admin-Passwort wird einmalig erzeugt und unter
# userdata/stromkreis/admin-password abgelegt (niemand muss es kennen -
# die Seiten kommen aus der JSONDB, das Konto verhindert nur den
# Einrichtungsassistenten).
# ============================================================================
set -uo pipefail

userdata="${OPENHAB_USERDATA:-/openhab/userdata}"
client="${OPENHAB_HOME:-/openhab}/runtime/bin/client"
up="${userdata}/etc/users.properties"
jaas="${userdata}/etc/org.apache.karaf.jaas.cfg"
pw_file="${userdata}/stromkreis/admin-password"
admin_user="demoadmin"

log() { echo "$(date '+%F %T') [ensure-admin] $*"; }

stored_password() {
  local pw="$1"
  if grep -qE '^[[:space:]]*encryption\.enabled[[:space:]]*=[[:space:]]*true' "$jaas" 2>/dev/null \
     && grep -qE '^[[:space:]]*encryption\.algorithm[[:space:]]*=[[:space:]]*SHA-256' "$jaas" 2>/dev/null; then
    printf '{CRYPT}%s{CRYPT}' "$(printf '%s' "$pw" | sha256sum | cut -d' ' -f1 | tr 'a-f' 'A-F')"
  else
    printf '%s' "$pw"
  fi
}

console() {
  local cmd="$1" tmppw stored out rc
  [ -f "$up" ] || return 1
  tmppw="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
  stored="$(stored_password "$tmppw")"
  cp -a "$up" "$up.stromkreis-tmp"
  sed -i -E "s|^([[:space:]]*openhab[[:space:]]*=[[:space:]]*)[^,]*|\1${stored}|" "$up"
  out="$(printf '%s\nlogout\n' "$cmd" | timeout 120 "$client" -p "$tmppw" 2>&1)"
  rc=$?
  mv "$up.stromkreis-tmp" "$up"
  printf '%s\n' "$out" | sed -e 's/\x1b\[[0-9;]*m//g'
  return "$rc"
}

if [ ! -f "$pw_file" ]; then
  mkdir -p "$(dirname "$pw_file")"
  (umask 077; od -An -tx1 -N12 /dev/urandom | tr -d ' \n' > "$pw_file")
fi
admin_pw="$(cat "$pw_file")"

# Bis zu 15 Minuten auf die Konsole warten (erster Start installiert Addons).
for i in $(seq 1 90); do
  sleep 10
  out="$(console "openhab:users list" 2>/dev/null)" || continue
  # "openhab:users" gibt es erst, wenn der Core hochgefahren ist.
  printf '%s\n' "$out" | grep -qi 'command not found' && continue
  if printf '%s\n' "$out" | grep -qi 'administrator'; then
    log "Admin-Konto vorhanden."
    exit 0
  fi
  console "openhab:users add $admin_user $admin_pw administrator" >/dev/null 2>&1 || true
  if console "openhab:users list" 2>/dev/null | grep -qi 'administrator'; then
    log "Admin-Konto '$admin_user' angelegt."
    exit 0
  fi
  log "Versuch $i: Konto noch nicht angelegt, Ausgabe: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
done
log "FEHLER: Admin-Konto konnte nicht angelegt werden."
exit 1
