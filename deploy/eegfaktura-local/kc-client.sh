#!/usr/bin/env bash
# Legt im Realm EEGFaktura den oeffentlichen Client fuer das Stromkreis-Login an
# (Authorization Code + PKCE, Refresh/Offline-Token fuer den Hintergrund-Import)
# bzw. aktualisiert ihn. Mapper wie beim app-Client (patch-realm.py): tenant
# (JSON-Attribut) und access_groups (Gruppenpfade). Kein Audience-Mapper: das
# Backend (jwt v3, aud als string) kann ein aud-Array nicht parsen.
# Laeuft am Server in /home/martin/Container/eegfaktura.
# Aufruf: kc-client.sh [client-id] [redirect-uri ...]
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./secrets.env; set +a
CLIENT_ID=${1:-net.stromkreis.platform}
shift || true
REDIRECTS=("$@")
[ ${#REDIRECTS[@]} -gt 0 ] || REDIRECTS=("https://stromkreis.net/auth/eegfaktura/callback" "http://localhost:5173/auth/eegfaktura/callback" "http://localhost:4000/auth/eegfaktura/callback")

KC=http://127.0.0.1:8180
ADMIN_TOKEN=$(curl -sS -f -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN_USER:-admin}&password=$KC_ADMIN_PW" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
API="$KC/admin/realms/EEGFaktura"
auth=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")

BODY=$(python3 - "$CLIENT_ID" "${REDIRECTS[@]}" <<'PY'
import json, sys
client_id, redirects = sys.argv[1], sys.argv[2:]
print(json.dumps({
    "clientId": client_id, "name": "Stromkreis Plattform", "enabled": True,
    "publicClient": True, "standardFlowEnabled": True, "implicitFlowEnabled": False,
    "directAccessGrantsEnabled": False, "serviceAccountsEnabled": False,
    "protocol": "openid-connect",
    "redirectUris": redirects, "webOrigins": ["+"],
    "attributes": {"pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "+"},
    "defaultClientScopes": ["web-origins", "acr", "roles", "profile", "email"],
    "optionalClientScopes": ["offline_access"],
    "protocolMappers": [
        {"name": "tenantAttributeMapper", "protocol": "openid-connect",
         "protocolMapper": "oidc-usermodel-attribute-mapper", "consentRequired": False,
         "config": {"userinfo.token.claim": "true", "user.attribute": "tenant", "id.token.claim": "true",
                    "access.token.claim": "true", "claim.name": "tenant", "jsonType.label": "JSON"}},
        {"name": "access_groups", "protocol": "openid-connect",
         "protocolMapper": "oidc-group-membership-mapper", "consentRequired": False,
         "config": {"full.path": "true", "multivalued": "true", "claim.name": "access_groups",
                    "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true"}},
    ],
}))
PY
)
EXISTING=$(curl -sS -f "$API/clients?clientId=$CLIENT_ID" "${auth[@]}" | python3 -c 'import sys,json;c=json.load(sys.stdin);print(c[0]["id"] if c else "")')
if [ -z "$EXISTING" ]; then
  echo "Client $CLIENT_ID anlegen"
  curl -sS -f -o /dev/null -X POST "$API/clients" "${auth[@]}" -d "$BODY"
else
  echo "Client $CLIENT_ID aktualisieren ($EXISTING)"
  # Mapper nicht doppelt anlegen: bestehende behalten, nur Basisdaten setzen
  curl -sS -f -o /dev/null -X PUT "$API/clients/$EXISTING" "${auth[@]}" \
    -d "$(printf '%s' "$BODY" | python3 -c 'import sys,json;b=json.load(sys.stdin);b.pop("protocolMappers");print(json.dumps(b))')"
fi
curl -sS -f "$API/clients?clientId=$CLIENT_ID" "${auth[@]}" | python3 -c '
import sys,json;c=json.load(sys.stdin)[0]
print("ok:",c["clientId"],"public",c["publicClient"],"redirects",c["redirectUris"],"mappers",[m["name"] for m in c.get("protocolMappers",[])],"optional scopes",c.get("optionalClientScopes"))'
