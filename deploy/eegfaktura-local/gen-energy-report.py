#!/usr/bin/env python3
"""Erzeugt einen EEG-Faktura-Energiereport (Sheet "Energiedaten") mit realistischen
Dummy-Daten fuer die Test-EEG TE100200, im Format des EDA-Reports, das der
energystore per GraphQL singleUpload importiert (siehe setup-eeg.sh, Schritt 5).

Aufruf:  gen-energy-report.py <von YYYY-MM-DD> <bis YYYY-MM-DD> <ausgabe.xlsx>
Braucht openpyxl. Deterministisch (fester Seed).

Modell: 6 Verbrauchs- und 5 Erzeugungszaehlpunkte aus den Muster-Stammdaten,
Haushaltsprofile mit Tages-/Wochen-/Jahresgang, PV nach Sonnenstand fuer Bad Ischl
mit Tageswetter (AR(1)-Bewoelkung), dynamische Zuteilung proportional zum Verbrauch. Wilsons PV geht erst am 1.3.2025 ans Netz.
Identitaeten je Viertelstunde: Summe Anteil = Gesamte Erzeugung;
Eigendeckung_i = min(Verbrauch_i, Anteil_i); Summe Ueberschuss = Erzeugung - Summe Eigendeckung.
Zeitstempel sind Ortszeit (Europe/Vienna) als naive Excel-Datumswerte, 96 Slots je Tag.
"""
import math
import random
import sys
from datetime import date, datetime, timedelta

from openpyxl import Workbook

LAT = 47.71  # Bad Ischl
SLOT_H = 0.25

CONSUMERS = [
    # (Zaehlpunkt, Name, Jahresverbrauch kWh, Profil, Beginn)
    ("AT0099990000000000000000000020100", "Max Mustermann", 4200, "haushalt", None),
    ("AT0099990000000000000000000020102", "Richard Finnegan", 3100, "haushalt", None),
    ("AT0099990000000000000000000020104", "Silvia Beckett", 7800, "waermepumpe", None),
    ("AT0099990000000000000000000020105", "Josef Wilson", 5600, "haushalt", None),
    ("AT0099990000000000000000000020108", "Rosa Crassus", 12500, "gewerbe", None),
    ("AT0099990000000000000000000020110", "Ronald Hendrix", 3600, "haushalt", None),
]
PRODUCERS = [
    # (Zaehlpunkt, Name, kWp, Ausrichtung in Grad (180 = Sued), Beginn)
    ("AT0000000000000000000000000000001", "Ingrid Thatcher", 5.2, 180, None),
    ("AT0000000000000000000000000000003", "Richard Finnegan", 8.0, 210, None),
    ("AT0000000000000000000000000000006", "Josef Wilson", 6.4, 150, date(2025, 3, 1)),
    ("AT0000000000000000000000000000007", "Rosa Crassus", 29.9, 180, None),
    ("AT0099990000000000000000030020109", "Ronald Hendrix", 9.8, 240, None),
]

HDR_CON = [
    "Gesamtverbrauch lt. Messung (bei Teilnahme gem. Erzeugung) [KWH]",
    "Anteil gemeinschaftliche Erzeugung [KWH]",
    "Eigendeckung gemeinschaftliche Erzeugung [KWH]",
]
HDR_GEN = [
    "Gesamte gemeinschaftliche Erzeugung [KWH]",
    "Gesamt/Überschusserzeugung, Gemeinschaftsüberschuss [KWH]",
]
DISCLAIMER = (
    "Die Informationen in den Reports werden auf Basis der Datensätze generiert, welche entsprechend den "
    "gesetzlichen Bestimmungen für intelligente Messgeräte vom Netzbetreiber übermittelt werden. "
    "TESTDATEN: synthetisch erzeugt fuer die Stromkreis-Testinstanz (deploy/eegfaktura-local/gen-energy-report.py)."
)


def solar_factor(day: date, hour: float, azimuth_deg: float) -> float:
    """Relative Einstrahlung auf die Modulflaeche (0..1) bei klarem Himmel."""
    doy = day.timetuple().tm_yday
    decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + doy) / 365)
    lat = math.radians(LAT)
    # Ortszeit ~ Sonnenzeit + Sommerzeit: grobe Korrektur ueber Laengengrad 13.6 und DST
    dst = 1 if date(day.year, 3, 31) - timedelta(days=(date(day.year, 3, 31).weekday() + 1) % 7) <= day < \
        date(day.year, 10, 31) - timedelta(days=(date(day.year, 10, 31).weekday() + 1) % 7) else 0
    solar_h = hour - dst - (15 - 13.6) / 15
    ha = math.radians(15 * (solar_h - 12))
    sin_el = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)
    if sin_el <= 0:
        return 0.0
    el = math.asin(sin_el)
    az = math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat) - math.tan(decl) * math.cos(lat)) + math.pi
    tilt = math.radians(30)
    cos_inc = (math.sin(el) * math.cos(tilt)
               + math.cos(el) * math.sin(tilt) * math.cos(az - math.radians(azimuth_deg)))
    airmass = 1 / max(sin_el, 0.05)
    clear = 0.75 ** (airmass ** 0.678)  # Atmosphaerendaempfung
    return max(cos_inc, 0.0) * clear


def daily_weather(days, rng):
    """Bewoelkungsfaktor je Tag (0.08 .. 1.0), AR(1) mit Jahresgang (Winter truebe)."""
    out = {}
    x = 0.0
    for d in days:
        season = 0.72 + 0.20 * math.cos(2 * math.pi * (d.timetuple().tm_yday - 190) / 365)
        x = 0.7 * x + rng.gauss(0, 0.28)
        out[d] = min(1.0, max(0.08, season + x))
    return out


def consumption_profile(kind, d: date, hour: float, rng) -> float:
    """Relativer Lastwert (Mittel ~1 ueber das Jahr)."""
    doy = d.timetuple().tm_yday
    winter = math.cos(2 * math.pi * (doy - 15) / 365)  # +1 Mitte Jaenner, -1 Mitte Juli
    weekend = d.weekday() >= 5
    if kind == "gewerbe":
        base = 0.35
        if not weekend and 7 <= hour < 18:
            base = 1.6 + 0.3 * math.sin(math.pi * (hour - 7) / 11)
        elif weekend and 9 <= hour < 13:
            base = 0.7
        base *= 1 + 0.15 * winter
    else:
        base = 0.45
        if 6 <= hour < 9:
            base = 1.3
        elif 11 <= hour < 14:
            base = 1.0 if weekend else 0.7
        elif 17 <= hour < 22:
            base = 1.9
        elif hour >= 22 or hour < 6:
            base = 0.4
        base *= 1 + 0.12 * winter
        if kind == "waermepumpe":
            heat = max(0.0, winter) * (1.6 + 0.4 * (1 if hour < 7 or hour >= 16 else 0))
            base += heat
    return base * rng.uniform(0.75, 1.25)


def main():
    start, end, out = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2]), sys.argv[3]
    rng = random.Random(20260826)
    days = [start + timedelta(n) for n in range((end - start).days + 1)]
    weather = daily_weather(days, rng)

    # Skalierung: Jahresverbrauch trifft, Profilmittel ~1 -> kWh je Slot = jahr/ (365*96) * profil
    con_scale = [c[2] / (365 * 96) for c in CONSUMERS]
    # PV: kWp * factor * 0.85 Systemwirkungsgrad * 0.25 h -> kWh je Slot
    gen_scale = [p[2] * 0.85 * SLOT_H for p in PRODUCERS]

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Energiedaten")
    ids, names, dirs, starts, ends, codes = ["MeteringpointID"], ["Name"], ["Energy direction"], \
        ["Period start"], ["Period end"], ["Metercode"]
    pstart, pend = datetime(start.year, start.month, start.day), datetime(end.year, end.month, end.day) + timedelta(days=1)
    for zp, name, _, _, begin in CONSUMERS:
        for h in HDR_CON:
            ids.append(zp); names.append(name); dirs.append("CONSUMPTION"); codes.append(h)
            starts.append(datetime.combine(max(begin, start), datetime.min.time()) if begin else pstart); ends.append(pend)
    for zp, name, _, _, begin in PRODUCERS:
        for h in HDR_GEN:
            ids.append(zp); names.append(name); dirs.append("GENERATION"); codes.append(h)
            starts.append(datetime.combine(max(begin, start), datetime.min.time()) if begin else pstart); ends.append(pend)
    ncols = len(ids) - 1
    ws.append([DISCLAIMER])
    ws.append(ids); ws.append(names); ws.append(dirs); ws.append(starts); ws.append(ends)
    ws.append(["MeteringReason"] + ["SM Datenübermittlung"] * ncols)
    ws.append(["Metering Interval"] + ["QH (viertelstündlich)"] * ncols)
    ws.append(["Number of Metering Intervals"] + [None] * ncols)
    ws.append(codes)
    ws.append(["Spaltensumme"] + [None] * ncols)

    tot = {"con": 0.0, "gen": 0.0, "cover": 0.0}
    for d in days:
        cloud = weather[d]
        for slot in range(96):
            hour = slot * SLOT_H
            ts = datetime(d.year, d.month, d.day) + timedelta(hours=hour)
            cons = [0.0 if (c[4] and d < c[4]) else round(s * consumption_profile(c[3], d, hour, rng), 3)
                    for c, s in zip(CONSUMERS, con_scale)]
            # Wolken variieren auch innerhalb des Tages leicht
            gens = [0.0 if (p[4] and d < p[4]) else
                    round(s * solar_factor(d, hour + 0.125, p[3]) * min(1.0, cloud * rng.uniform(0.85, 1.1)), 3)
                    for p, s in zip(PRODUCERS, gen_scale)]
            C, G = sum(cons), sum(gens)
            shares = [G * c / C if C > 0 else 0.0 for c in cons]
            covers = [min(c, s) for c, s in zip(cons, shares)]
            cover_sum = sum(covers)
            surplus_ratio = (G - cover_sum) / G if G > 0 else 0.0
            row = [ts]
            for c, s, v in zip(cons, shares, covers):
                row += [c, round(s, 6), round(v, 6)]
            for g in gens:
                row += [g, round(g * surplus_ratio, 6)]
            ws.append(row)
            tot["con"] += C; tot["gen"] += G; tot["cover"] += cover_sum
    wb.save(out)
    print(f"{out}: {len(days)} Tage, {len(days) * 96} Zeilen, {ncols} Spalten; "
          f"Verbrauch {tot['con']:.0f} kWh, Erzeugung {tot['gen']:.0f} kWh, "
          f"Eigendeckung {tot['cover']:.0f} kWh ({100 * tot['cover'] / tot['gen']:.0f}% der Erzeugung, "
          f"{100 * tot['cover'] / tot['con']:.0f}% des Verbrauchs)")


if __name__ == "__main__":
    main()
