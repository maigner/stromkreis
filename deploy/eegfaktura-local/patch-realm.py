#!/usr/bin/env python3
"""Patcht keycloak/import/realm-export.json des eegfaktura-docker-compose-Stacks
fuer die Stromkreis-Testinstanz auf 'server' (siehe docs/eegfaktura-lokal.md):
- Realm-frontendUrl (Token-Issuer) und Redirect-URIs der SPA-Clients auf den Server-Host
- Client at.ourproject.vfeeg.api (confidential, Direct Access Grants, tenant-Mapper) fuer ProtectApi
- festes admin-cli-Secret (muss zu keycloak.json passen)
- Benutzer 'manager' (Realm-Rolle Manager) fuer das Admin-Portal
<host> ist die Basis-Domain (eegfaktura-test.stromkreis.net); SPA unter https://<host>,
Admin-Portal unter https://admin.<host>, Keycloak unter https://auth.<host> (Caddy, TLS).
Aufruf: patch-realm.py <realm-export.json> <host> <admin-cli-secret> <api-secret> <manager-passwort> <importer-passwort> <rc-nummer>
- Benutzer 'importer' (Gruppe EEG_ADMIN, tenant ["<rc>"], nicht-temporaeres Passwort) fuer den Stromkreis-Importer (ProtectApi)
Das tenant-Attribut ist bei EEG-Faktura ein JSON-String '["RC..."]', den der Mapper (jsonType JSON) zum Array macht; NICHT multivalued.
"""
import json, sys, uuid
path, host, admin_cli_secret, api_secret, manager_pw, importer_pw, rc = sys.argv[1:8]
r = json.load(open(path))
origins = [f"https://{host}", f"https://admin.{host}", "http://localhost:8001", "http://localhost:8002"]
# Realm-frontendUrl bestimmt den Token-Issuer und ueberstimmt KC_HOSTNAME; muss der
# Unified Hostname sein, sonst brechen backend/energystore beim Start ab (Issuer-Mismatch).
r.setdefault("attributes", {})["frontendUrl"] = f"https://auth.{host}"
clients = {c["clientId"]: c for c in r["clients"]}
clients["at.ourproject.vfeeg.app"]["redirectUris"] = [o + "/*" for o in origins]
clients["at.ourproject.vfeeg.admin"]["redirectUris"] = [o + "/*" for o in origins]
for cid in ("at.ourproject.vfeeg.app", "at.ourproject.vfeeg.admin"):
    clients[cid]["webOrigins"] = ["+"]
clients["admin-cli"]["secret"] = admin_cli_secret
clients["admin-cli"]["attributes"].pop("client.secret.creation.time", None)

if "at.ourproject.vfeeg.api" not in clients:
    app = clients["at.ourproject.vfeeg.app"]
    api = {
        "id": str(uuid.uuid4()),
        "clientId": "at.ourproject.vfeeg.api",
        "name": "apiclient",
        "description": "Backend API validation client (ProtectApi: Basic-Auth -> Password Grant)",
        "enabled": True,
        "clientAuthenticatorType": "client-secret",
        "secret": api_secret,
        "redirectUris": [],
        "webOrigins": [],
        "bearerOnly": False,
        "consentRequired": False,
        "standardFlowEnabled": False,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": True,
        "serviceAccountsEnabled": False,
        "publicClient": False,
        "frontchannelLogout": False,
        "protocol": "openid-connect",
        "attributes": {"access.token.lifespan": "3600"},
        "fullScopeAllowed": True,
        "nodeReRegistrationTimeout": -1,
        "protocolMappers": [
            {
                "id": str(uuid.uuid4()),
                "name": "tenantAttributeMapper",
                "protocol": "openid-connect",
                "protocolMapper": "oidc-usermodel-attribute-mapper",
                "consentRequired": False,
                "config": {
                    "userinfo.token.claim": "true",
                    "user.attribute": "tenant",
                    "id.token.claim": "true",
                    "access.token.claim": "true",
                    "claim.name": "tenant",
                    "jsonType.label": "JSON",
                },
            }
        ],
        "defaultClientScopes": list(app["defaultClientScopes"]),
        "optionalClientScopes": list(app["optionalClientScopes"]),
    }
    r["clients"].append(api)

# Gruppen-Mapper: backend/energystore lesen access_groups ("/EEG_ADMIN"), admin-web liest groups.
# Im Compose-Export fehlen beide, obwohl docs/architecture/auth.md sie als Pflicht nennt.
def group_mapper(name):
    return {
        "id": str(uuid.uuid4()), "name": name, "protocol": "openid-connect",
        "protocolMapper": "oidc-group-membership-mapper", "consentRequired": False,
        "config": {"full.path": "true", "multivalued": "true", "claim.name": name,
                   "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true"},
    }
clients = {c["clientId"]: c for c in r["clients"]}
for cid in ("at.ourproject.vfeeg.app", "at.ourproject.vfeeg.api", "at.ourproject.vfeeg.admin"):
    pms = clients[cid].setdefault("protocolMappers", [])
    for name in ("access_groups", "groups"):
        if not any(m["name"] == name for m in pms):
            pms.append(group_mapper(name))

users = r.setdefault("users", [])
if not any(u["username"] == "manager" for u in users):
    users.append({
        "id": str(uuid.uuid4()),
        "username": "manager",
        "enabled": True,
        "emailVerified": True,
        "firstName": "Test",
        "lastName": "Manager",
        "email": "manager@example.invalid",
        "credentials": [{"type": "password", "value": manager_pw, "temporary": False}],
        "realmRoles": ["Manager", "default-roles-eegfaktura"],
        "requiredActions": [],
        "groups": [],
    })
if not any(u["username"] == "importer" for u in users):
    users.append({
        "id": str(uuid.uuid4()),
        "username": "importer",
        "enabled": True,
        "emailVerified": True,
        "firstName": "Stromkreis",
        "lastName": "Importer",
        "email": "importer@example.invalid",
        "attributes": {"tenant": [json.dumps([rc.upper()])]},
        "credentials": [{"type": "password", "value": importer_pw, "temporary": False}],
        "realmRoles": ["default-roles-eegfaktura"],
        "groups": ["/EEG_ADMIN"],
        "requiredActions": [],
    })
json.dump(r, open(path, "w"), indent=2, ensure_ascii=False)
print("ok:", [c["clientId"] for c in r["clients"] if "vfeeg" in c["clientId"] or c["clientId"] == "admin-cli"], [u["username"] for u in users])
