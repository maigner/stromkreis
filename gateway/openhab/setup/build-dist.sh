#!/usr/bin/env bash
# ============================================================================
# Packt das Gateway-Paket fuer die Auslieferung ueber die Plattform.
#
# Erzeugt in platform/static/gateway/:
#   stromkreis-gateway.tgz          das Paket
#   stromkreis-gateway.tgz.sha256   Pruefsumme (vom Bootstrap verifiziert)
#   stromkreis-gateway.tgz.sig      Ed25519-Signatur (base64), install.sh prueft sie
#   stromkreis-gateway.pub          Public-Key dazu (base64 DER; fuer Gateways
#                                   ohne festgeschriebenen Schluessel, TOFU)
#   VERSION                         Stand, den die Anlagen melden
#
# Signatur: privater Schluessel ausserhalb des Repos
# (~/.config/stromkreis/package-signing.key oder $STROMKREIS_SIGNING_KEY,
# Ed25519-PEM von "openssl genpkey -algorithm ed25519"); er muss zum
# eingecheckten Public-Key platform/src/lib/server/stromkreis-gateway.pub
# passen, sonst wuerden die Gateways das Paket ablehnen. Siehe docs/sicherheit.md.
#
# Endung .tgz statt .tar.gz: sirv (adapter-node) liefert *.gz-Dateien mit
# "Content-Encoding: gzip" aus - Clients ohne Accept-Encoding bekommen dann
# das entpackte Tar und die Pruefsumme schlaegt fehl.
#
# Wird von deploy/deploy.sh vor dem rsync aufgerufen; fuer einen lokalen
# Test kann es auch einzeln ausgefuehrt werden.
# ============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
openhab_dir="$(cd "$here/.." && pwd)"          # gateway/openhab
repo_root="$(cd "$openhab_dir/../.." && pwd)"  # Repository-Wurzel
dist_dir="$repo_root/platform/static/gateway"

tarball="$dist_dir/stromkreis-gateway.tgz"
checksum="$tarball.sha256"
signature="$tarball.sig"
signing_key="${STROMKREIS_SIGNING_KEY:-$HOME/.config/stromkreis/package-signing.key}"
pubkey_file="$repo_root/platform/src/lib/server/stromkreis-gateway.pub"

log() { echo "[Stromkreis] $*"; }
die() { echo "[Stromkreis] FEHLER: $*" >&2; exit 1; }

[ -d "$repo_root/platform/static" ] || die "platform/static nicht gefunden - Repository-Wurzel falsch erkannt: $repo_root"
[ -f "$openhab_dir/setup/install-gateway.sh" ] || die "setup/install-gateway.sh nicht gefunden in $openhab_dir"

command -v python3 >/dev/null 2>&1 || die "python3 fehlt (wird fuer die Overview-Konvertierung gebraucht)."
command -v openssl >/dev/null 2>&1 || die "openssl fehlt (signiert das Paket)."
[ -f "$signing_key" ] || die "Signaturschluessel fehlt: $signing_key (auf dem Deploy-Rechner anlegen bzw. hinkopieren, siehe docs/sicherheit.md)."
[ -f "$pubkey_file" ] || die "Public-Key fehlt: $pubkey_file"
derived_pub="$(openssl pkey -in "$signing_key" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')" \
  || die "Signaturschluessel nicht lesbar: $signing_key"
[ "$derived_pub" = "$(tr -d '[:space:]' < "$pubkey_file")" ] \
  || die "Signaturschluessel $signing_key passt nicht zum eingecheckten Public-Key $pubkey_file - die Gateways wuerden das Paket ablehnen."
python3 -c 'import yaml' 2>/dev/null || die "PyYAML fehlt: sudo apt install python3-yaml"

mkdir -p "$dist_dir"

# Main-UI-Seiten der Profile in das REST-Format wandeln - die Main UI
# speichert Seiten in der JSONDB, 05-install-overview.sh schreibt sie daher
# per REST API und braucht jede Seite als page-<uid>.json.
generated_pages=()
for ov in "$openhab_dir"/inverters/*/overview.yaml; do
  [ -f "$ov" ] || continue
  dir="$(dirname "$ov")"
  python3 - "$ov" "$dir" <<'PY' || die "Seiten-Konvertierung fehlgeschlagen: $ov"
import json, os, sys, yaml
src, dstdir = sys.argv[1], sys.argv[2]
with open(src) as f:
    data = yaml.safe_load(f)
for uid, page in data["pages"].items():
    with open(os.path.join(dstdir, "page-" + uid + ".json"), "w") as f:
        json.dump({"uid": uid, **page}, f, ensure_ascii=False, indent=2)
PY
  for p in "$dir"/page-*.json; do
    generated_pages+=("$p")
    log "erzeugt: $p"
  done
done

# Build-Information mit ins Paket, damit auf dem Pi nachvollziehbar ist,
# welcher Stand installiert wurde.
build_info="$openhab_dir/BUILD-INFO"
{
  echo "gebaut am: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "gebaut auf: $(hostname)"
} > "$build_info"

log "Packe $openhab_dir ..."
tar -czf "$tarball" \
    -C "$(dirname "$openhab_dir")" \
    --exclude='setup/gateway.conf' \
    --exclude='*.bak-*' \
    --exclude='.gitignore' \
    --exclude='inverters/*/tools/sim_*' \
    --exclude='inverters/*/tools/spike_*' \
    --exclude='__pycache__' \
    "$(basename "$openhab_dir")"

# Versionsstring, wie ihn die Anlagen melden (04-install-rules.sh aus
# BUILD-INFO): die Plattform vergleicht damit den Stand jeder Anlage.
{
  d="$(sed -n 's/^gebaut am: \([0-9-]*\).*/\1/p' "$build_info")"
  c="$(sed -n 's/^commit: \(.*\)/\1/p' "$build_info")"
  printf '%s%s\n' "${d:-unbekannt}" "${c:+ ($c)}"
} > "$dist_dir/VERSION"
log "erzeugt: $dist_dir/VERSION ($(cat "$dist_dir/VERSION"))"

rm -f "$build_info"
[ "${#generated_pages[@]}" -gt 0 ] && rm -f "${generated_pages[@]}"

( cd "$dist_dir" && sha256sum "$(basename "$tarball")" > "$(basename "$checksum")" )

# Signatur (rohe Ed25519-Signatur, base64 in einer Zeile) und Public-Key
openssl pkeyutl -sign -inkey "$signing_key" -rawin -in "$tarball" | base64 | tr -d '\n' > "$signature" \
  || die "Signieren fehlgeschlagen."
tr -d '[:space:]' < "$pubkey_file" > "$dist_dir/stromkreis-gateway.pub"

log "erzeugt: $tarball ($(du -h "$tarball" | cut -f1))"
log "erzeugt: $checksum"
log "erzeugt: $signature (signiert mit $signing_key)"
log "Ausgeliefert wird das Paket ueber die Plattform unter /gateway/stromkreis-gateway.tgz."
