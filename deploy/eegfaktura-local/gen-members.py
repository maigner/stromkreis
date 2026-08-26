#!/usr/bin/env python3
"""Erzeugt die Mitglieder-Konfiguration (JSON) einer Dummy-EEG fuer gen-eeg.py.

Aufruf: gen-members.py <rc> <name> <plz> <ort> <anzahl> <seed> <ausgabe.json> [--strassen "A,B,C"]

Deterministisch je Seed. Jedes Mitglied hat einen Verbrauchszaehlpunkt, etwa 40% zusaetzlich
eine PV-Anlage (Erzeugungszaehlpunkt); Profile haushalt/waermepumpe/gewerbe; ein Teil der
Mitglieder steigt erst spaeter ein (Beginn im Zeitraum). Zaehlpunkt-Nummern sind erfunden
(Netzbetreiber AT009999), Namen und Adressen ebenso.
"""
import json
import random
import sys
from datetime import date, timedelta

FIRST = ["Anna", "Franz", "Maria", "Johann", "Elisabeth", "Josef", "Christine", "Karl", "Andrea", "Georg",
         "Sabine", "Peter", "Monika", "Thomas", "Barbara", "Michael", "Claudia", "Markus", "Petra", "Stefan",
         "Ursula", "Wolfgang", "Renate", "Herbert", "Brigitte", "Alois", "Gerlinde", "Leopold", "Silvia", "Hubert"]
LAST = ["Gruber", "Huber", "Bauer", "Wagner", "Mueller", "Pichler", "Steiner", "Moser", "Mayer", "Hofer",
        "Leitner", "Berger", "Fuchs", "Eder", "Fischer", "Schmid", "Winkler", "Weber", "Schwarz", "Maier",
        "Reiter", "Wimmer", "Auer", "Egger", "Lang", "Baumgartner", "Haas", "Lehner", "Wallner", "Aigner"]
GEWERBE = ["Tischlerei", "Baeckerei", "Gasthof", "Pension", "Kfz-Werkstatt", "Elektro", "Nahversorger"]


def main():
    rc, name, plz, ort, n, seed, out = sys.argv[1:8]
    n, seed = int(n), int(seed)
    streets = None
    if "--strassen" in sys.argv:
        streets = sys.argv[sys.argv.index("--strassen") + 1].split(",")
    streets = streets or ["Hauptstrasse", "Bahnhofstrasse", "Kirchengasse", "Seestrasse", "Bergweg", "Feldgasse"]
    rng = random.Random(seed)
    digits = rc[2:]  # z.B. 100300
    members = []
    used = set()
    for i in range(1, n + 1):
        while True:
            fn, ln = rng.choice(FIRST), rng.choice(LAST)
            if (fn, ln) not in used:
                used.add((fn, ln)); break
        r = rng.random()
        if r < 0.10:
            profile, annual = "gewerbe", rng.randint(9000, 25000)
            fn, ln = rng.choice(GEWERBE), ln  # Firmenname: "Tischlerei Gruber"
        elif r < 0.28:
            profile, annual = "waermepumpe", rng.randint(6000, 11000)
        else:
            profile, annual = "haushalt", rng.randint(2200, 6500)
        begin = None
        if rng.random() < 0.2:  # Spaeteinsteiger: irgendwann im letzten Jahr
            begin = (date(2025, 1, 1) + timedelta(days=rng.randint(0, 540))).replace(day=1).isoformat()
        m = {
            "first": fn, "last": ln, "business": profile == "gewerbe",
            "street": rng.choice(streets), "nr": str(rng.randint(1, 120)),
            "consumption": {"zp": f"AT009999{'0' * 17}{digits}{i:02d}", "annual_kwh": annual,
                            "profile": profile, "begin": begin},
        }
        if rng.random() < 0.42:
            kwp = round(rng.uniform(4, 15), 1) if profile != "gewerbe" else round(rng.uniform(20, 45), 1)
            m["generation"] = {"zp": f"AT009999{'0' * 16}1{digits}{i:02d}", "kwp": kwp,
                               "azimuth": rng.choice([150, 165, 180, 195, 210, 225, 240]), "begin": begin}
        members.append(m)
    cfg = {
        "rc": rc, "community_id": f"AT00999900000TC{digits}00000000000{digits[-1]}",
        "grid": "AT009999", "name": name, "plz": plz, "ort": ort,
        "street": streets[0], "street_nr": "1",
        "members": members,
    }
    json.dump(cfg, open(out, "w"), indent=1, ensure_ascii=False)
    pv = [m for m in members if "generation" in m]
    print(f"{out}: {n} Mitglieder, {len(pv)} mit PV ({sum(m['generation']['kwp'] for m in pv):.1f} kWp), "
          f"{sum(m['consumption']['annual_kwh'] for m in members) / 1000:.0f} MWh/a Verbrauch")


if __name__ == "__main__":
    main()
