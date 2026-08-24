#!/usr/bin/env bash
# Legt in der EEG-Faktura-Testinstanz die Test-EEG an und laedt Stammdaten und
# Energiedaten hoch. Idempotent: eine bereits vorhandene EEG wird uebersprungen.
# Laeuft am Server im Ordner /home/martin/Container/eegfaktura.
# Voraussetzung: Stack laeuft (docker compose ps), secrets.env vorhanden.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./secrets.env; set +a

KC=http://server.fritz.box:8180/realms/EEGFaktura/protocol/openid-connect/token
ADMIN=http://localhost:8002
APP=http://localhost:8001
RC=${RC_NUMBER:-TE100200}
EC_ID=${COMMUNITY_ID:-AT00999900000TC100200000000000002}
GRID_ID=${GRID_ID:-AT009999}
EEG_ADMIN_USER=${EEG_ADMIN_USER:-eegadmin}
EEG_ADMIN_PW=${EEG_ADMIN_PW:-EEGFaktura#123}
EEG_ADMIN_MAIL=${EEG_ADMIN_MAIL:-eegadmin@example.invalid}

token() { # token <client-id> <user> <pw> [client-secret]
  local data="grant_type=password&client_id=$1&username=$2&password=$3&scope=openid"
  [ -n "${4:-}" ] && data="$data&client_secret=$4"
  curl -sS -f -X POST "$KC" -d "$data" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'
}

echo "== 1) Manager-Token (Admin-Client, Direct Access Grant)"
MGR_TOKEN=$(token at.ourproject.vfeeg.admin manager "$MANAGER_PW")

echo "== 2) EEG $RC registrieren (Admin-Backend /eeg/register)"
if curl -sS -o /dev/null -w '%{http_code}' "$ADMIN/admin/eeg/users" -H "Authorization: Bearer $MGR_TOKEN" | grep -q 200; then :; fi
BODY=$(python3 - "$RC" "$EC_ID" "$GRID_ID" "$EEG_ADMIN_USER" "$EEG_ADMIN_PW" "$EEG_ADMIN_MAIL" <<'PY'
import json, sys
rc, ec, grid, user, pw, mail = sys.argv[1:7]
print(json.dumps({
  "tenant": rc, "rcNumber": rc, "communityId": ec,
  "name": "Test-EEG Stromkreis", "description": "Testinstanz fuer den Stromkreis-Importer", "online": False,
  "accountInfo": {"iban": "AT12 3456 7891 2345", "owner": "Test-EEG", "sepa": False},
  "businessInfo": {"legal": "verein", "settlementInterval": "MONTHLY"},
  "grid": {"id": grid, "name": "Test-Netzbetreiber", "area": "LOCAL", "allocation": "DYNAMIC"},
  "contact": {"street": "Teststrasse", "streetNumber": "1", "city": "Bad Ischl", "zip": "4820", "web": None, "phone": None},
  "pontonInfo": {"username": "", "password": "", "domain": "", "host": None, "port": None, "pontonCommType": "NONE"},
  "user": {"username": user, "password": pw, "firstname": "EEG", "lastname": "Admin", "email": mail},
}))
PY
)
CODE=$(curl -sS -o /tmp/register.out -w '%{http_code}' -X POST "$ADMIN/admin/eeg/register" \
  -H "Authorization: Bearer $MGR_TOKEN" -H "Content-Type: application/json" -d "$BODY")
echo "register: HTTP $CODE $(cat /tmp/register.out)"
case "$CODE" in 200|201) ;; 400) echo "(EEG existiert vermutlich schon, weiter)";; *) exit 1;; esac

echo "== 3) Token des Importer-Benutzers (api-Client, Password Grant) fuer die Uploads"
IMP_TOKEN=$(token at.ourproject.vfeeg.api importer "$IMPORTER_PW" "$API_SECRET")

echo "== 4) Stammdaten hochladen (backend /api/eeg/import/masterdata, Sheet 'EEG Stammdaten')"
CODE=$(curl -sS -o /tmp/master.out -w '%{http_code}' -X POST "$APP/api/eeg/import/masterdata" \
  -H "Authorization: Bearer $IMP_TOKEN" -H "tenant: $RC" -H "X-Tenant: $RC" \
  -F "sheet=EEG Stammdaten" -F "masterdatafile=@data/TE100200-Muster-Stammdatenimport.xlsx")
echo "masterdata: HTTP $CODE $(head -c 400 /tmp/master.out)"

echo "== 5) Energiedaten hochladen (energystore GraphQL singleUpload, Sheet 'Energiedaten')"
OPS=$(python3 -c "import json,sys;print(json.dumps({'operationName':None,'query':'mutation (\$energyData: Upload!) { singleUpload(tenant: \"'+sys.argv[1].lower()+'\", ecId: \"'+sys.argv[2]+'\", sheet: \"Energiedaten\", file: \$energyData) }','variables':{'energyData':None}}))" "$RC" "$EC_ID")
CODE=$(curl -sS -o /tmp/energy.out -w '%{http_code}' -X POST "$APP/energystore/query" \
  -H "Authorization: Bearer $IMP_TOKEN" -H "X-Tenant: $RC" -H "Accept: application/json" \
  -F "operations=$OPS" -F 'map={"0":["variables.energyData"]}' \
  -F "0=@data/TEST_EEG_Report_AT00999900000TE100100.xlsx")
echo "energydata: HTTP $CODE $(head -c 400 /tmp/energy.out)"

echo "== 6) Smoke-Test ProtectApi (Basic, wie der Stromkreis-Importer): metadata + masterdata"
# ecId der Energiedaten-Endpunkte ist die Gemeinschafts-ID (energystore speichert je <tenant>/<ecId>);
# mit der RC-Nummer kommt ein leeres {} zurueck. X-Tenant bleibt die RC-Nummer.
B64URL=$(printf '%s:%s' importer "$IMPORTER_PW" | base64 | tr '+/' '-_')
B64STD=$(printf '%s:%s' importer "$IMPORTER_PW" | base64)
curl -sS -w '\nmetadata: HTTP %{http_code}\n' -X POST "$APP/energystore/query/$EC_ID/metadata" \
  -H "Authorization: Basic $B64URL" -H "X-Tenant: $RC" -H "Content-Type: application/json" -d '{}'
curl -sS -o /tmp/md.out -w 'masterdata (api): HTTP %{http_code}\n' "$APP/api/master/masterdata" \
  -H "Authorization: Basic $B64STD" -H "X-Tenant: $RC"; head -c 300 /tmp/md.out; echo
