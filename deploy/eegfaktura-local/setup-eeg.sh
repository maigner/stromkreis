#!/usr/bin/env bash
# Legt in der EEG-Faktura-Testinstanz eine Dummy-EEG an und laedt Stammdaten und
# Energiedaten hoch. Idempotent: eine bereits vorhandene EEG wird uebersprungen,
# Uploads ueberschreiben vorhandene Daten. Laeuft am Server im Ordner
# /home/martin/Container/eegfaktura. Voraussetzung: Stack laeuft, secrets.env vorhanden.
#
# Aufruf: setup-eeg.sh [eegs/<RC>.json]     (Default: eegs/TE100200.json)
#
# Die Konfiguration (siehe gen-members.py) liefert RC-Nummer, Gemeinschafts-ID, Name,
# Adresse sowie optional:
#   admin_user      Benutzer, den die Registrierung anlegt (Default eegadmin; temporaeres Passwort)
#   upload_user     Benutzer fuer die Uploads und den Importer (Default importer); er bekommt
#                   per kc-user.sh die RC-Nummer ins tenant-Attribut und ein festes Passwort
#                   aus secrets.env (<UPLOAD_USER in Grossbuchstaben>_PW, z.B. IMPORTER_PW, DERKASSIER_PW)
#   stammdaten, energiedaten   Dateinamen unter data/ (Default <RC>-Stammdaten.xlsx, <RC>-Energiedaten.xlsx)
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./secrets.env; set +a

CFG=${1:-eegs/TE100200.json}
cfg() { python3 -c 'import sys,json;c=json.load(open(sys.argv[1]));v=c.get(sys.argv[2],sys.argv[3] if len(sys.argv)>3 else "");print(v)' "$CFG" "$@"; }
RC=$(cfg rc); RC=${RC^^}
EC_ID=$(cfg community_id)
GRID_ID=$(cfg grid AT009999)
EEG_NAME=$(cfg name "Test-EEG $RC")
ZIP=$(cfg plz 4820); CITY=$(cfg ort "Bad Ischl"); STREET=$(cfg street Teststrasse); STREET_NR=$(cfg street_nr 1)
ADMIN_USER=$(cfg admin_user eegadmin)
ADMIN_PW=${EEG_ADMIN_PW:-EEGFaktura#123}
UPLOAD_USER=$(cfg upload_user importer)
UPLOAD_PW_VAR="${UPLOAD_USER^^}_PW"; UPLOAD_PW=${!UPLOAD_PW_VAR:?$UPLOAD_PW_VAR fehlt in secrets.env}
MASTER_FILE=data/$(cfg stammdaten "$RC-Stammdaten.xlsx")
ENERGY_FILE=data/$(cfg energiedaten "$RC-Energiedaten.xlsx")
test -f "$MASTER_FILE" && test -f "$ENERGY_FILE" || { echo "FEHLER: $MASTER_FILE oder $ENERGY_FILE fehlt (gen-eeg.py)"; exit 1; }

KC=https://auth.eegfaktura-test.stromkreis.net/realms/EEGFaktura/protocol/openid-connect/token
ADMIN=http://localhost:8002
APP=http://localhost:8001

token() { # token <client-id> <user> <pw> [client-secret]
  local data="grant_type=password&client_id=$1&username=$2&password=$3&scope=openid"
  [ -n "${4:-}" ] && data="$data&client_secret=$4"
  curl -sS -f -X POST "$KC" -d "$data" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'
}

echo "== EEG $RC ($EEG_NAME, $CITY), Gemeinschafts-ID $EC_ID, Upload-Benutzer $UPLOAD_USER"

echo "== 1) Manager-Token (Admin-Client, Direct Access Grant)"
MGR_TOKEN=$(token at.ourproject.vfeeg.admin manager "$MANAGER_PW")

echo "== 2) EEG $RC registrieren (Admin-Backend /eeg/register, Admin-Benutzer $ADMIN_USER)"
BODY=$(python3 - "$RC" "$EC_ID" "$GRID_ID" "$ADMIN_USER" "$ADMIN_PW" "$EEG_NAME" "$ZIP" "$CITY" "$STREET" "$STREET_NR" <<'PY'
import json, sys
rc, ec, grid, user, pw, name, zip_, city, street, nr = sys.argv[1:11]
print(json.dumps({
  "tenant": rc, "rcNumber": rc, "communityId": ec,
  "name": name, "description": "Testinstanz fuer den Stromkreis-Importer (Dummy-Daten)", "online": False,
  "accountInfo": {"iban": "AT12 3456 7891 2345", "owner": name, "sepa": False},
  "businessInfo": {"legal": "verein", "settlementInterval": "MONTHLY"},
  "grid": {"id": grid, "name": "Test-Netzbetreiber", "area": "LOCAL", "allocation": "DYNAMIC"},
  "contact": {"street": street, "streetNumber": nr, "city": city, "zip": zip_, "web": None, "phone": None},
  "pontonInfo": {"username": "", "password": "", "domain": "", "host": None, "port": None, "pontonCommType": "NONE"},
  "user": {"username": user, "password": pw, "firstname": "EEG", "lastname": "Admin", "email": user.lower() + "@example.invalid"},
}))
PY
)
CODE=$(curl -sS -o /tmp/register.out -w '%{http_code}' -X POST "$ADMIN/admin/eeg/register" \
  -H "Authorization: Bearer $MGR_TOKEN" -H "Content-Type: application/json" -d "$BODY")
echo "register: HTTP $CODE $(head -c 300 /tmp/register.out)"
case "$CODE" in 200|201) ;; 400|409) echo "(EEG existiert vermutlich schon, weiter)";; *) exit 1;; esac

echo "== 3) Upload-Benutzer $UPLOAD_USER: Passwort, Gruppe EEG_ADMIN, tenant += $RC"
./kc-user.sh "$UPLOAD_USER" "$UPLOAD_PW" "$RC"

echo "== 4) Token des Upload-Benutzers (api-Client, Password Grant)"
UP_TOKEN=$(token at.ourproject.vfeeg.api "$UPLOAD_USER" "$UPLOAD_PW" "$API_SECRET")

echo "== 5) Stammdaten hochladen ($MASTER_FILE, Sheet 'EEG Stammdaten')"
CODE=$(curl -sS -o /tmp/master.out -w '%{http_code}' -X POST "$APP/api/eeg/import/masterdata" \
  -H "Authorization: Bearer $UP_TOKEN" -H "tenant: $RC" -H "X-Tenant: $RC" \
  -F "sheet=EEG Stammdaten" -F "masterdatafile=@$MASTER_FILE")
echo "masterdata: HTTP $CODE $(head -c 400 /tmp/master.out)"

echo "== 6) Energiedaten hochladen ($ENERGY_FILE, energystore GraphQL singleUpload, Sheet 'Energiedaten')"
OPS=$(python3 -c "import json,sys;print(json.dumps({'operationName':None,'query':'mutation (\$energyData: Upload!) { singleUpload(tenant: \"'+sys.argv[1].lower()+'\", ecId: \"'+sys.argv[2]+'\", sheet: \"Energiedaten\", file: \$energyData) }','variables':{'energyData':None}}))" "$RC" "$EC_ID")
CODE=$(curl -sS -o /tmp/energy.out -w '%{http_code}' -X POST "$APP/energystore/query" \
  -H "Authorization: Bearer $UP_TOKEN" -H "X-Tenant: $RC" -H "Accept: application/json" \
  -F "operations=$OPS" -F 'map={"0":["variables.energyData"]}' \
  -F "0=@$ENERGY_FILE")
echo "energydata: HTTP $CODE $(head -c 400 /tmp/energy.out)"

echo "== 7) Smoke-Test ProtectApi (Basic, wie der Stromkreis-Importer): metadata + masterdata"
# ecId der Energiedaten-Endpunkte ist die Gemeinschafts-ID (energystore speichert je <tenant>/<ecId>);
# X-Tenant bleibt die RC-Nummer. energystore dekodiert URL-safe Base64, das Backend Standard-Base64.
B64URL=$(printf '%s:%s' "$UPLOAD_USER" "$UPLOAD_PW" | base64 | tr '+/' '-_')
B64STD=$(printf '%s:%s' "$UPLOAD_USER" "$UPLOAD_PW" | base64)
curl -sS -o /tmp/meta.out -w 'metadata: HTTP %{http_code} ' -X POST "$APP/energystore/query/$EC_ID/metadata" \
  -H "Authorization: Basic $B64URL" -H "X-Tenant: $RC" -H "Content-Type: application/json" -d '{}'
python3 -c 'import json;d=json.load(open("/tmp/meta.out"));print(len(d),"Zaehlpunkte mit Daten")'
curl -sS -o /tmp/md.out -w 'masterdata (api): HTTP %{http_code} ' "$APP/api/master/masterdata" \
  -H "Authorization: Basic $B64STD" -H "X-Tenant: $RC"
python3 -c 'import json;d=json.load(open("/tmp/md.out"));print(len(d),"Teilnehmer,",sum(len(p.get("meters",[])) for p in d),"Zaehlpunkte")'
