#!/usr/bin/env python3
"""Gibt den Mitgliedern einer Dummy-EEG echte Adressen aus dem Ort (OpenStreetMap-Auszug in
eegs/adressen.json, je PLZ 400 Wohnadressen) und schreibt sie in EEG-Faktura.

Aufruf:
  set-addresses.py eegs/<RC>.json            Adressen deterministisch zuweisen, JSON aktualisieren
  set-addresses.py eegs/<RC>.json --apply    zusaetzlich in EEG-Faktura schreiben (am Server, braucht
                                             secrets.env: API_SECRET und <UPLOAD_USER>_PW)

--apply holt GET /api/participant, ordnet die Teilnehmer per Vor- und Nachname den Mitgliedern zu,
setzt Wohn- und Rechnungsadresse per PUT /api/participant/{id} (Vollupdate mit den gelesenen Daten)
und die Adresse jedes Zaehlpunkts per PUT /api/meteringpoint/v2/{pid}/update/{mid} (Feld fuer Feld).
Nur Stdlib, laeuft am Server neben setup-eeg.sh. Idempotent.
"""
import base64
import json
import os
import random
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KC = "https://auth.eegfaktura-test.stromkreis.net/realms/EEGFaktura/protocol/openid-connect/token"
APP = os.environ.get("EEGFAKTURA_APP", "http://localhost:8001")


def assign(cfg_path):
    cfg = json.load(open(cfg_path))
    pools = json.load(open(os.path.join(HERE, "eegs", "adressen.json")))
    pool = pools.get(cfg["plz"])
    if not pool:
        sys.exit(f"keine Adressen fuer PLZ {cfg['plz']} in eegs/adressen.json")
    rng = random.Random(int(cfg["rc"][2:]))
    addrs = rng.sample(pool["adressen"], len(cfg["members"]))
    for m, a in zip(cfg["members"], addrs):
        m["street"], m["nr"] = a["street"], a["nr"]
    cfg["ort"] = pool["ort"]
    json.dump(cfg, open(cfg_path, "w"), indent=1, ensure_ascii=False)
    print(f"{cfg_path}: {len(addrs)} Adressen zugewiesen ({cfg['plz']} {cfg['ort']})")
    return cfg


def token(user, pw, secret):
    data = urllib.parse.urlencode({"grant_type": "password", "client_id": "at.ourproject.vfeeg.api",
                                   "client_secret": secret, "username": user, "password": pw, "scope": "openid"}).encode()
    with urllib.request.urlopen(urllib.request.Request(KC, data=data)) as r:
        return json.load(r)["access_token"]


def call(method, path, tok, rc, body=None):
    req = urllib.request.Request(APP + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {tok}", "tenant": rc, "X-Tenant": rc,
                                          "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]


def apply(cfg):
    rc = cfg["rc"].upper()
    user = cfg.get("upload_user", "importer")
    pw = os.environ.get(f"{user.upper()}_PW") or sys.exit(f"{user.upper()}_PW fehlt (secrets.env)")
    tok = token(user, pw, os.environ["API_SECRET"])
    status, participants = call("GET", "/api/participant", tok, rc)
    if status != 200:
        sys.exit(f"GET participant: HTTP {status} {participants}")
    by_name = {(p.get("firstname", "").strip(), p.get("lastname", "").strip()): p for p in participants}
    ok = missing = 0
    for m in cfg["members"]:
        p = by_name.get((m["first"], m["last"]))
        if not p:
            print(f"  nicht gefunden: {m['first']} {m['last']}"); missing += 1; continue
        addr = {"street": m["street"], "streetNumber": m["nr"], "zip": cfg["plz"], "city": cfg["ort"]}
        p["residentAddress"] = {**(p.get("residentAddress") or {}), **addr, "type": "RESIDENCE"}
        p["billingAddress"] = {**(p.get("billingAddress") or {}), **addr, "type": "BILLING"}
        status, res = call("PUT", f"/api/participant/{p['id']}", tok, rc, p)
        if status not in (200, 202):
            print(f"  {m['first']} {m['last']}: PUT participant HTTP {status} {res}"); continue
        for meter in p.get("meters") or []:
            for field in ("street", "streetNumber", "zip", "city"):
                status, res = call("PUT", f"/api/meteringpoint/v2/{p['id']}/update/{meter['meteringPoint']}", tok, rc,
                                   {"path": field, "value": addr[field]})
                if status not in (200, 202):
                    print(f"  {meter['meteringPoint']} {field}: HTTP {status} {res}")
        ok += 1
        print(f"  {m['first']} {m['last']}: {m['street']} {m['nr']}, {cfg['plz']} {cfg['ort']} ({len(p.get('meters') or [])} ZP)")
    print(f"{rc}: {ok} Teilnehmer aktualisiert, {missing} nicht gefunden, {len(participants) - ok - missing} weitere Teilnehmer unveraendert")


if __name__ == "__main__":
    cfg = assign(sys.argv[1])
    if "--apply" in sys.argv:
        apply(cfg)
