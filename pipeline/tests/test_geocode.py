"""Tests fuer die Geokodierung der Mitglieder (ohne Netz: fetch wird ersetzt)."""

import pytest

from stromkreis_pipeline import geocode


def test_split_address():
    assert geocode.split_address("Ischlerstraße 37b, 4802 Ebensee am Traunsee") == ("Ischlerstraße 37b", "4802", "Ebensee am Traunsee")
    assert geocode.split_address("Hauptplatz 1") == ("Hauptplatz 1", None, None)


def test_geocode_address_strukturiert_dann_freitext():
    calls = []

    def fetch(params):
        calls.append(params)
        return [] if "street" in params else [{"lat": "47.8", "lon": "13.76"}]

    assert geocode.geocode_address("Ischlerstraße 37b, 4802 Ebensee am Traunsee", fetch) == (47.8, 13.76)
    assert calls[0]["street"] == "Ischlerstraße 37b" and calls[0]["postalcode"] == "4802" and calls[0]["countrycodes"] == "at"
    assert calls[1]["q"] == "Ischlerstraße 37b, 4802 Ebensee am Traunsee"

    # Dritter Versuch ohne Hausnummer (Strassenebene)
    calls.clear()
    fetch3 = lambda p: [{"lat": "47.79", "lon": "13.75"}] if p.get("street") == "Am Grünanger" else (calls.append(p) or [])
    assert geocode.geocode_address("Am Grünanger 14, 4802 Ebensee am Traunsee", fetch3) == (47.79, 13.75)
    assert len(calls) == 2
    assert geocode.geocode_address("Nirgendwo 1, 9999 Nirgends", lambda p: []) is None
    assert geocode.geocode_address(None, lambda p: [{"lat": 1, "lon": 2}]) is None


def test_geocode_address_fehler_wirft_geocode_error():
    """Fehlgeschlagene Anfrage (Netz, Timeout) ist etwas anderes als kein Treffer."""
    def fetch(params):
        raise OSError("timeout")

    with pytest.raises(geocode.GeocodeError):
        geocode.geocode_address("Ischlerstraße 37b, 4802 Ebensee am Traunsee", fetch)


@pytest.fixture
def tenant_id(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("insert into tenant (slug, name, latitude, longitude) values ('pytest-geo', 'Pytest Geo', 47.7, 13.6) returning id")
        tenant_id = cur.fetchone()[0]
    db_conn.commit()
    return tenant_id


def test_geocode_members_und_anlagen_nachziehen(db_conn, tenant_id):
    with db_conn.cursor() as cur:
        cur.execute(
            "insert into member (tenant_id, name, role, address) values (%s, 'Anna Gruber', 'member', 'Alte Straße 1, 4802 Ebensee am Traunsee') returning id",
            (tenant_id,),
        )
        member_id = cur.fetchone()[0]
        # Anlage mit Mitgliedsadresse auf dem Gemeinschafts-Mittelpunkt (Fallback beim Anlegen)
        cur.execute(
            """
            insert into battery_site (tenant_id, member_id, name, inverter_profile, token_hash, latitude, longitude, address)
            values (%s, %s, 'Anlage Anna', 'fronius-symo', 'pytest-tok-1', 47.7, 13.6, 'Alte Straße 1, 4802 Ebensee am Traunsee') returning id
            """,
            (tenant_id, member_id),
        )
        site_id = cur.fetchone()[0]
        # Von Hand verschobene Anlage: eigene Adresse, bleibt unberuehrt
        cur.execute(
            """
            insert into battery_site (tenant_id, member_id, name, inverter_profile, token_hash, latitude, longitude, address)
            values (%s, %s, 'Huette', 'fronius-symo', 'pytest-tok-2', 47.5, 13.5, 'Almweg 9, 4802 Ebensee am Traunsee') returning id
            """,
            (tenant_id, member_id),
        )
        manual_id = cur.fetchone()[0]

    fetch = lambda p: [{"lat": "47.80", "lon": "13.76"}]
    assert geocode.geocode_members(db_conn, tenant_id, fetch) == (1, 0)
    assert geocode.geocode_members(db_conn, tenant_id, fetch) == (0, 0)  # nichts mehr zu tun

    with db_conn.cursor() as cur:
        cur.execute("select latitude, longitude, geocoded_address from member where id = %s", (member_id,))
        assert cur.fetchone() == (47.8, 13.76, "Alte Straße 1, 4802 Ebensee am Traunsee")
        cur.execute("select latitude, longitude, address from battery_site where id = %s", (site_id,))
        assert cur.fetchone() == (47.8, 13.76, "Alte Straße 1, 4802 Ebensee am Traunsee")
        cur.execute("select latitude, longitude, address from battery_site where id = %s", (manual_id,))
        assert cur.fetchone() == (47.5, 13.5, "Almweg 9, 4802 Ebensee am Traunsee")

        # Adressaenderung beim naechsten Import: Mitglied und Anlage ziehen mit
        cur.execute("update member set address = 'Neue Gasse 2, 4802 Ebensee am Traunsee' where id = %s", (member_id,))
    assert geocode.geocode_members(db_conn, tenant_id, lambda p: [{"lat": "47.81", "lon": "13.77"}]) == (1, 0)
    with db_conn.cursor() as cur:
        cur.execute("select latitude, longitude, address from battery_site where id = %s", (site_id,))
        assert cur.fetchone() == (47.81, 13.77, "Neue Gasse 2, 4802 Ebensee am Traunsee")

        # Kein Treffer: alte Koordinaten bleiben, geocoded_address gesetzt (kein Dauerversuch)
        cur.execute("update member set address = 'Unbekannt 1, 4802 Ebensee am Traunsee' where id = %s", (member_id,))
    assert geocode.geocode_members(db_conn, tenant_id, lambda p: []) == (0, 1)
    with db_conn.cursor() as cur:
        cur.execute("select latitude, longitude, geocoded_address from member where id = %s", (member_id,))
        assert cur.fetchone() == (47.81, 13.77, "Unbekannt 1, 4802 Ebensee am Traunsee")
        cur.execute("select latitude, address from battery_site where id = %s", (site_id,))
        assert cur.fetchone() == (47.81, "Unbekannt 1, 4802 Ebensee am Traunsee")
    assert geocode.geocode_members(db_conn, tenant_id, lambda p: []) == (0, 0)  # kein Dauerversuch


def test_geocode_members_anfragefehler_laesst_zeile_offen(db_conn, tenant_id, caplog):
    """Nominatim nicht erreichbar: kein Update, die Zeile bleibt offen und der
    Lauf bricht ab; der naechste Lauf holt es nach."""
    with db_conn.cursor() as cur:
        cur.execute(
            "insert into member (tenant_id, name, role, address, latitude, longitude, geocoded_address) "
            "values (%s, 'Anna Gruber', 'member', 'Neue Gasse 2, 4802 Ebensee am Traunsee', 47.7, 13.6, 'Alte Straße 1, 4802 Ebensee am Traunsee'), "
            "(%s, 'Berta Huber', 'member', 'Seeweg 5, 4802 Ebensee am Traunsee', null, null, null) returning id",
            (tenant_id, tenant_id),
        )
        ids = [r[0] for r in cur.fetchall()]
    calls = []

    def fetch(params):
        calls.append(params)
        raise OSError("timeout")

    with caplog.at_level("WARNING"):
        assert geocode.geocode_members(db_conn, tenant_id, fetch) == (0, 0)
    assert len(calls) == 1  # nach dem ersten Fehler keine weiteren Anfragen
    assert "Neue Gasse" not in caplog.text and "Seeweg" not in caplog.text
    with db_conn.cursor() as cur:
        cur.execute("select latitude, longitude, geocoded_address from member where id = %s", (ids[0],))
        assert cur.fetchone() == (47.7, 13.6, "Alte Straße 1, 4802 Ebensee am Traunsee")
        cur.execute("select geocoded_address from member where id = %s", (ids[1],))
        assert cur.fetchone() == (None,)

    # Naechster Lauf mit erreichbarem Nominatim holt beide nach
    assert geocode.geocode_members(db_conn, tenant_id, lambda p: [{"lat": "47.80", "lon": "13.76"}]) == (2, 0)
    with db_conn.cursor() as cur:
        cur.execute("select latitude, geocoded_address from member where id = %s", (ids[1],))
        assert cur.fetchone() == (47.8, "Seeweg 5, 4802 Ebensee am Traunsee")


def test_geocode_fehler_loggt_keine_adresse(caplog):
    """Adressen sind personenbezogen und gehoeren nicht ins Log (S7)."""
    def fetch(params):
        raise OSError("timeout")

    with caplog.at_level("WARNING"), pytest.raises(geocode.GeocodeError):
        geocode.geocode_address("Ischlerstraße 37b, 4802 Ebensee am Traunsee", fetch)
    assert "Ischlerstraße" not in caplog.text
    assert "fehlgeschlagen" in caplog.text


def test_geocode_tenants_und_anlagen_auf_dem_mittelpunkt(db_conn, tenant_id, caplog):
    with db_conn.cursor() as cur:
        # Mandant wie vom Login angelegt: Adresse da, Platzhalter-Standort, noch nicht geokodiert
        cur.execute("update tenant set latitude = 47.59, longitude = 14.14, address = '4820 Bad Ischl' where id = %s", (tenant_id,))
        # Anlage auf dem Mittelpunkt (Fallback beim Anlegen) und eine mit eigenem Standort
        cur.execute(
            "insert into battery_site (tenant_id, name, inverter_profile, token_hash, latitude, longitude) "
            "values (%s, 'Mitte', 'fronius-symo', 'pytest-tok-t1', 47.59, 14.14), (%s, 'Eigen', 'fronius-symo', 'pytest-tok-t2', 47.5, 13.5) returning id",
            (tenant_id, tenant_id),
        )
        ids = [r[0] for r in cur.fetchall()]

    assert geocode.geocode_tenants(db_conn, lambda p: [{"lat": "47.71", "lon": "13.62"}]) == (1, 0)
    assert geocode.geocode_tenants(db_conn, lambda p: [{"lat": "0", "lon": "0"}]) == (0, 0)  # nichts mehr zu tun
    with db_conn.cursor() as cur:
        cur.execute("select latitude, longitude, geocoded_address from tenant where id = %s", (tenant_id,))
        assert cur.fetchone() == (47.71, 13.62, "4820 Bad Ischl")
        cur.execute("select latitude, longitude from battery_site where id = %s", (ids[0],))
        assert cur.fetchone() == (47.71, 13.62)
        cur.execute("select latitude, longitude from battery_site where id = %s", (ids[1],))
        assert cur.fetchone() == (47.5, 13.5)

        # Kein Treffer: Standort bleibt, geocoded_address gesetzt, Adresse nicht im Log
        cur.execute("update tenant set address = 'Nirgendwo 1, 9999 Irgendwo' where id = %s", (tenant_id,))
    with caplog.at_level("WARNING"):
        assert geocode.geocode_tenants(db_conn, lambda p: []) == (0, 1)
    assert "Nirgendwo" not in caplog.text
    with db_conn.cursor() as cur:
        cur.execute("select latitude, geocoded_address from tenant where id = %s", (tenant_id,))
        assert cur.fetchone() == (47.71, "Nirgendwo 1, 9999 Irgendwo")

        # Anfragefehler: Zeile bleibt offen (geocoded_address unveraendert)
        cur.execute("update tenant set address = '4802 Ebensee' where id = %s", (tenant_id,))

    def fetch(params):
        raise OSError("timeout")

    assert geocode.geocode_tenants(db_conn, fetch) == (0, 0)
    with db_conn.cursor() as cur:
        cur.execute("select latitude, geocoded_address from tenant where id = %s", (tenant_id,))
        assert cur.fetchone() == (47.71, "Nirgendwo 1, 9999 Irgendwo")
