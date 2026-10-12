"""Geokodierung der Mitglieds- und Mandantenadressen (Nominatim, OpenStreetMap).

Adressen sind personenbezogene Daten und erscheinen deshalb nie im Log, nur
Mandant und Mitglieds-ID (Befund S7 der Sicherheitspruefung 9/2026).

Nach jedem Mitgliederimport bekommen Mitglieder, deren Adresse sich seit der
letzten Geokodierung geaendert hat (member.address <> member.geocoded_address),
neue Koordinaten. Anlagen des Mitglieds, die noch die alte Mitgliedsadresse
tragen (also nicht von Hand angepasst wurden), werden mitgezogen: Adresse und
Koordinaten. Anlagen, die auf dem Gemeinschafts-Mittelpunkt liegen (Fallback
beim Anlegen ohne Mitgliedskoordinaten), bekommen ebenfalls die Koordinaten.

Nominatim-Nutzungsbedingungen: hoechstens eine Anfrage je Sekunde, aussagekraeftiger
User-Agent; die Adressen werden als strukturierte Anfrage (Strasse, PLZ, Ort,
Land AT) gestellt. Datenquelle der Ergebnisse: (c) OpenStreetMap-Mitwirkende, ODbL.

Zwei Faelle werden unterschieden: "Anfrage fehlgeschlagen" (Netz, Timeout,
HTTP-Fehler; GeocodeError) laesst die Zeile offen (address bleibt verschieden
von geocoded_address) und bricht den Lauf ab, weil Nominatim vermutlich gerade
nicht erreichbar ist. "Kein Treffer" behaelt die alten Koordinaten und setzt
geocoded_address, damit die Adresse nicht bei jedem Lauf erneut gefragt wird.
Die Nominatim-Anfragen (mit Pausen) laufen vor den DB-Updates, die dann am
Stueck folgen: so bleiben member/battery_site nicht waehrend der Pausen gesperrt.
"""

import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
USER_AGENT = os.environ.get("NOMINATIM_USER_AGENT", "stromkreis.net worker (https://stromkreis.net)")
MIN_INTERVAL = 1.1  # Sekunden zwischen zwei Anfragen
_last_request = 0.0


class GeocodeError(RuntimeError):
    """Nominatim-Anfrage fehlgeschlagen (Netz, Timeout, HTTP-Fehler); kein Befund zur Adresse."""


def split_address(address):
    """'Strasse 3a, 4802 Ebensee am Traunsee' -> (street, postalcode, city)."""
    street, _, rest = address.partition(",")
    m = re.match(r"\s*(\d{4})\s+(.+)$", rest)
    if m:
        return street.strip(), m.group(1), m.group(2).strip()
    return street.strip(), None, rest.strip() or None


def nominatim_fetch(params):
    """Eine Nominatim-Suche; Rueckgabe: Liste der Treffer (JSON)."""
    global _last_request
    wait = _last_request + MIN_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    url = f"{NOMINATIM_URL}/search?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    finally:
        _last_request = time.monotonic()


def geocode_address(address, fetch=nominatim_fetch):
    """Koordinaten (lat, lon) einer Adresse oder None (kein Treffer). Erst
    strukturiert mit Hausnummer, dann Freitext; nur Treffer in Oesterreich.
    Wirft GeocodeError, wenn eine Anfrage fehlschlaegt."""
    if not address:
        return None
    street, plz, city = split_address(address)
    queries = [{"street": street, "postalcode": plz, "city": city}, {"q": address}]
    # Fallback auf Strassenebene, wenn Nominatim die Hausnummer nicht kennt
    street_only = re.sub(r"\s+\d+\S*$", "", street)
    if street_only != street:
        queries.append({"street": street_only, "postalcode": plz, "city": city})
    for q in queries:
        params = {"format": "jsonv2", "limit": 1, "countrycodes": "at", **{k: v for k, v in q.items() if v}}
        try:
            hits = fetch(params)
        except Exception as err:  # Netz, Timeout, 429: der naechste Lauf versucht es erneut
            log.warning("Geokodierung fehlgeschlagen (naechster Lauf versucht es erneut): %s", err)
            raise GeocodeError(str(err)) from err
        if hits:
            return float(hits[0]["lat"]), float(hits[0]["lon"])
    return None


def _lookup_all(todo, fetch, describe):
    """Nominatim fuer eine Liste von (key, address, ...)-Zeilen befragen.

    Rueckgabe: (Ergebnisse [(row, coords oder None)], gefunden, ohne Treffer).
    Bei einer fehlgeschlagenen Anfrage endet die Schleife; die restlichen
    Zeilen bleiben offen (keine Ergebnisse dafuer)."""
    results = []
    found = missed = 0
    for row in todo:
        try:
            coords = geocode_address(row[1], fetch)
        except GeocodeError:
            log.warning("%s: Geokodierung abgebrochen, %d Adressen bleiben offen", describe(row), len(todo) - len(results))
            break
        if coords:
            found += 1
        else:
            missed += 1
            log.warning("%s: Adresse nicht geokodierbar, Koordinaten bleiben", describe(row))
        results.append((row, coords))
    return results, found, missed


def geocode_members(conn, tenant_id, fetch=nominatim_fetch):
    """Mitglieder mit geaenderter Adresse geokodieren und ihre Anlagen nachziehen.

    Rueckgabe: (geokodiert, ohne Treffer). Commit macht der Aufrufer.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, address, geocoded_address, latitude, longitude from member
            where tenant_id = %s and address is not null and address is distinct from geocoded_address
            order by id
            """,
            (tenant_id,),
        )
        todo = cur.fetchall()
        if not todo:
            return 0, 0
        cur.execute("select latitude, longitude from tenant where id = %s", (tenant_id,))
        center = cur.fetchone() or (None, None)

    # Erst alle Anfragen (mit Pausen), dann die Updates am Stueck
    results, found, missed = _lookup_all(todo, fetch, lambda row: f"Tenant {tenant_id}, Mitglied {row[0]}")

    with conn.cursor() as cur:
        for (member_id, address, old_address, old_lat, old_lon), coords in results:
            if coords:
                lat, lon = coords
                cur.execute(
                    """
                    update member set latitude = %s, longitude = %s, geocoded_address = %s, geocoded_at = now()
                    where tenant_id = %s and id = %s
                    """,
                    (lat, lon, address, tenant_id, member_id),
                )
            else:
                # Kein Treffer: Koordinaten bleiben, geocoded_address verhindert den Dauerversuch
                cur.execute(
                    "update member set geocoded_address = %s, geocoded_at = now() where tenant_id = %s and id = %s",
                    (address, tenant_id, member_id),
                )
            # Anlagen, die noch die alte Mitgliedsadresse (oder keine) tragen: Adresse mitziehen
            cur.execute(
                """
                update battery_site set address = %s
                where tenant_id = %s and member_id = %s and (address is null or address = %s)
                """,
                (address, tenant_id, member_id, old_address),
            )
            if coords:
                # Koordinaten mitziehen, wenn die Anlage auf den alten Mitgliedskoordinaten
                # oder auf dem Gemeinschafts-Mittelpunkt liegt (also nicht von Hand gesetzt)
                cur.execute(
                    """
                    update battery_site set latitude = %s, longitude = %s
                    where tenant_id = %s and member_id = %s and address = %s and (
                        (latitude = %s and longitude = %s) or (latitude = %s and longitude = %s))
                    """,
                    (lat, lon, tenant_id, member_id, address, old_lat, old_lon, center[0], center[1]),
                )
    return found, missed


def geocode_tenants(conn, fetch=nominatim_fetch):
    """Mandanten mit neuer Adresse (tenant.address <> geocoded_address) geokodieren.

    Der Login legt einen Mandanten mit der Adresse aus EEG-Faktura und einem
    Platzhalter-Standort (Mitte Oesterreichs) an; hier bekommt er seine
    echten Koordinaten. Anlagen, die auf dem alten Mittelpunkt liegen
    (Fallback beim Anlegen), ziehen mit. Ohne Treffer bleiben die
    Koordinaten, geocoded_address wird trotzdem gesetzt (kein Dauerversuch);
    bei fehlgeschlagener Anfrage bleibt die Zeile offen.
    Rueckgabe: (geokodiert, ohne Treffer). Commit macht der Aufrufer.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, address, latitude, longitude from tenant
            where address is not null and address is distinct from geocoded_address
            order by id
            """
        )
        todo = cur.fetchall()
    if not todo:
        return 0, 0

    results, found, missed = _lookup_all(todo, fetch, lambda row: f"Tenant {row[0]}")

    with conn.cursor() as cur:
        for (tenant_id, address, old_lat, old_lon), coords in results:
            if coords:
                lat, lon = coords
                cur.execute(
                    """
                    update tenant set latitude = %s, longitude = %s, geocoded_address = %s, geocoded_at = now()
                    where id = %s
                    """,
                    (lat, lon, address, tenant_id),
                )
                cur.execute(
                    """
                    update battery_site set latitude = %s, longitude = %s
                    where tenant_id = %s and latitude = %s and longitude = %s
                    """,
                    (lat, lon, tenant_id, old_lat, old_lon),
                )
            else:
                cur.execute(
                    "update tenant set geocoded_address = %s, geocoded_at = now() where id = %s",
                    (address, tenant_id),
                )
    return found, missed
