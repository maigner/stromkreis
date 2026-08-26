#!/usr/bin/env bash
# Legt einen EEG-Faktura-Benutzer im Realm EEGFaktura an bzw. aktualisiert ihn:
# festes (nicht-temporaeres) Passwort, Gruppe EEG_ADMIN, tenant-Attribut um die
# RC-Nummer erweitert (JSON-String '["TE100200","TE100300"]', siehe patch-realm.py).
# Laeuft am Server im Ordner /home/martin/Container/eegfaktura (Keycloak auf 127.0.0.1:8180).
# Aufruf: kc-user.sh <benutzer> <passwort> <rc-nummer>
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./secrets.env; set +a
USER_NAME=$1; USER_PW=$2; RC=${3^^}
KC=http://127.0.0.1:8180
ADMIN_TOKEN=$(curl -sS -f -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN_USER:-admin}&password=$KC_ADMIN_PW" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
API="$KC/admin/realms/EEGFaktura"
auth=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")

USER_JSON=$(curl -sS -f "$API/users?username=$USER_NAME&exact=true" "${auth[@]}")
USER_ID=$(printf '%s' "$USER_JSON" | python3 -c 'import sys,json;u=json.load(sys.stdin);print(u[0]["id"] if u else "")')
if [ -z "$USER_ID" ]; then
  echo "Benutzer $USER_NAME anlegen"
  curl -sS -f -o /dev/null -X POST "$API/users" "${auth[@]}" -d "$(python3 -c 'import sys,json;print(json.dumps({
    "username": sys.argv[1], "enabled": True, "emailVerified": True,
    "firstName": sys.argv[1], "lastName": "Test", "email": sys.argv[1].lower()+"@example.invalid"}))' "$USER_NAME")"
  USER_ID=$(curl -sS -f "$API/users?username=$USER_NAME&exact=true" "${auth[@]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
fi

echo "tenant-Attribut um $RC erweitern"
NEW_USER=$(curl -sS -f "$API/users/$USER_ID" "${auth[@]}" | python3 -c '
import sys, json
u = json.load(sys.stdin); rc = sys.argv[1]
attrs = u.get("attributes") or {}
cur = attrs.get("tenant") or ["[]"]
try:
    tenants = json.loads(cur[0]) if cur[0].startswith("[") else [cur[0]]
except Exception:
    tenants = [cur[0]]
tenants = [t.upper() for t in tenants]
if rc not in tenants: tenants.append(rc)
attrs["tenant"] = [json.dumps(tenants)]
u["attributes"] = attrs; u["enabled"] = True; u["requiredActions"] = []
print(json.dumps(u))' "$RC")
curl -sS -f -o /dev/null -X PUT "$API/users/$USER_ID" "${auth[@]}" -d "$NEW_USER"

echo "Passwort setzen (nicht temporaer)"
curl -sS -f -o /dev/null -X PUT "$API/users/$USER_ID/reset-password" "${auth[@]}" \
  -d "$(python3 -c 'import sys,json;print(json.dumps({"type":"password","value":sys.argv[1],"temporary":False}))' "$USER_PW")"

echo "Gruppe EEG_ADMIN sicherstellen"
GROUP_ID=$(curl -sS -f "$API/groups?search=EEG_ADMIN" "${auth[@]}" | python3 -c 'import sys,json;print([g["id"] for g in json.load(sys.stdin) if g["name"]=="EEG_ADMIN"][0])')
curl -sS -f -o /dev/null -X PUT "$API/users/$USER_ID/groups/$GROUP_ID" "${auth[@]}"

curl -sS -f "$API/users/$USER_ID" "${auth[@]}" | python3 -c 'import sys,json;u=json.load(sys.stdin);print("ok:",u["username"],u.get("attributes",{}).get("tenant"))'
