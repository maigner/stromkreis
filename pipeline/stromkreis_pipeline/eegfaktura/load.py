"""Laden der normalisierten Records in das Plattform-Schema.

Jede Query ist mandantengefiltert. Der Upsert ist idempotent auf dem
Primaerschluessel von measurement (tenant, Zaehlpunkt, Kategorie, Intervall);
wiederholte Laeufe ueberschreiben Werte nur mit der neuesten Lieferung
(Ersatzwerte werden nachtraeglich korrigiert, deshalb das Ueberlappungsfenster
in sync.py).
"""

import logging

from .normalize import METER_CODES, METER_CODE_UNIT

log = logging.getLogger(__name__)


def ensure_meter_codes(conn, tenant_id):
    """Die fuenf EEG-Faktura-Kategorien fuer den Mandanten anlegen bzw.
    deren kind-Schluessel setzen. Rueckgabe: kind zu meter_code.id."""
    codes = {}
    with conn.cursor() as cur:
        for kind, description in METER_CODES.items():
            cur.execute(
                """
                insert into meter_code (tenant_id, description, unit, kind)
                values (%s, %s, %s, %s)
                on conflict (tenant_id, description, unit)
                    do update set kind = excluded.kind
                returning id
                """,
                (tenant_id, description, METER_CODE_UNIT, kind),
            )
            codes[kind] = cur.fetchone()[0]
    return codes


def ensure_measurement_points(conn, tenant_id, points):
    """Zaehlpunkte anlegen bzw. Richtung/Label nachziehen.

    points: Iterable von (metering_point, direction, label oder None).
    Rueckgabe: metering_point zu measurement_point.id fuer alle Zaehlpunkte
    des Mandanten (auch nicht uebergebene).
    """
    wanted = {}
    for metering_point, direction, label in points:
        # Bei Duplikaten gewinnt der Eintrag mit Label (masterdata vor rawdata)
        current = wanted.get(metering_point)
        if current is None or (current[1] is None and label is not None):
            wanted[metering_point] = (direction, label)

    with conn.cursor() as cur:
        cur.execute(
            "select id, metering_point, direction, label from measurement_point where tenant_id = %s",
            (tenant_id,),
        )
        existing = {mp: (pid, direction, label) for pid, mp, direction, label in cur.fetchall()}

        ids = {mp: pid for mp, (pid, _, _) in existing.items()}
        for metering_point, (direction, label) in wanted.items():
            if metering_point not in existing:
                cur.execute(
                    """
                    insert into measurement_point (tenant_id, metering_point, direction, label)
                    values (%s, %s, %s, %s)
                    returning id
                    """,
                    (tenant_id, metering_point, direction, label),
                )
                ids[metering_point] = cur.fetchone()[0]
                continue
            pid, old_direction, old_label = existing[metering_point]
            new_label = label if label is not None else old_label
            if old_direction != direction or old_label != new_label:
                cur.execute(
                    "update measurement_point set direction = %s, label = %s where tenant_id = %s and id = %s",
                    (direction, new_label, tenant_id, pid),
                )
    return ids


def upsert_measurements(conn, tenant_id, records, point_ids, code_ids):
    """Records per COPY in eine Temp-Tabelle schreiben und set-basiert
    upserten. Rueckgabe: Anzahl geschriebener Zeilen."""
    rows = [
        (point_ids[r.metering_point], code_ids[r.kind], r.measured_at, r.value, r.quality)
        for r in records
    ]
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.execute(
            """
            create temp table tmp_measurement (
                measurement_point_id bigint,
                meter_code_id bigint,
                measured_at timestamptz,
                value numeric(19, 10),
                quality smallint
            ) on commit drop
            """
        )
        with cur.copy(
            "copy tmp_measurement (measurement_point_id, meter_code_id, measured_at, value, quality) from stdin"
        ) as copy:
            for row in rows:
                copy.write_row(row)
        cur.execute(
            """
            insert into measurement (tenant_id, measurement_point_id, meter_code_id, measured_at, value, quality)
            select %s, measurement_point_id, meter_code_id, measured_at, value, quality
            from tmp_measurement
            on conflict (tenant_id, measurement_point_id, meter_code_id, measured_at)
                do update set value = excluded.value, quality = excluded.quality
            """,
            (tenant_id,),
        )
        count = cur.rowcount
        cur.execute("drop table tmp_measurement")
    return count


def daily_reporting_share(conn, tenant_id, day_start, day_end):
    """Meldeanteil eines Tages: Anteil der Zaehlpunkte des Mandanten, die im
    Fenster [day_start, day_end) mindestens einen Wert geliefert haben.
    Grundlage fuer das Vertrauens-Gate (ISCHLSTROM: 85%). Tagesgrenzen in
    Europe/Vienna bestimmt der Aufrufer."""
    with conn.cursor() as cur:
        cur.execute("select count(*) from measurement_point where tenant_id = %s", (tenant_id,))
        total = cur.fetchone()[0]
        if total == 0:
            return 0.0
        cur.execute(
            """
            select count(distinct measurement_point_id) from measurement
            where tenant_id = %s and measured_at >= %s and measured_at < %s
            """,
            (tenant_id, day_start, day_end),
        )
        reporting = cur.fetchone()[0]
    return reporting / total


def _find_member(cur, tenant_id, p):
    """Zeile fuer einen Teilnehmer finden: zuerst ueber die EEG-Faktura-Teilnehmer-ID,
    sonst ueber die E-Mail einer Zeile ohne Teilnehmer-ID (Betreiber-/Vorstandszeile
    aus dem Login); nur Teilnehmer ohne ID fallen auf den Namen zurueck."""
    if p["external_id"] is not None:
        cur.execute(
            "select id from member where tenant_id = %s and eegfaktura_participant_id = %s order by id limit 1",
            (tenant_id, p["external_id"]),
        )
        row = cur.fetchone()
        if row:
            return row[0]
    if p["email"]:
        cur.execute(
            """
            select id from member
            where tenant_id = %s and eegfaktura_participant_id is null and lower(email) = lower(%s)
            order by id limit 1
            """,
            (tenant_id, p["email"]),
        )
        row = cur.fetchone()
        if row:
            return row[0]
    if p["external_id"] is None:
        cur.execute(
            "select id from member where tenant_id = %s and eegfaktura_participant_id is null and name = %s order by id limit 1",
            (tenant_id, p["name"]),
        )
        row = cur.fetchone()
        if row:
            return row[0]
    return None


def upsert_members(conn, tenant_id, participants):
    """Teilnehmer aus EEG-Faktura in member uebernehmen (Rolle member).

    Schluessel ist die EEG-Faktura-Teilnehmer-ID; ohne Treffer darueber bekommt
    die Zeile ohne Teilnehmer-ID mit passender E-Mail (Betreiber-/Vorstandszeile
    aus dem Login) die Teilnehmerdaten, Teilnehmer ohne ID werden ueber den
    Namen zugeordnet. Eine Zeile wechselt nie zu einer anderen Teilnehmer-ID.
    Gehoert die E-Mail schon einer anderen Zeile (unique (tenant_id, email)),
    wird der Teilnehmer ohne E-Mail gefuehrt (eine Warnung je Teilnehmer, ohne
    die Adresse im Log). Rueckgabe: Anzahl verarbeiteter Teilnehmer.
    """
    count = 0
    with conn.cursor() as cur:
        for p in participants:
            member_id = _find_member(cur, tenant_id, p)
            email = p["email"]
            if email:
                cur.execute(
                    """
                    select id from member
                    where tenant_id = %s and lower(email) = lower(%s) and (%s::bigint is null or id <> %s)
                    limit 1
                    """,
                    (tenant_id, email, member_id, member_id),
                )
                if cur.fetchone():
                    log.warning(
                        "Tenant %s: E-Mail von Teilnehmer %s gehoert schon einem anderen Mitglied, Teilnehmer ohne E-Mail",
                        tenant_id, p["external_id"] or p["participant_number"] or p["name"],
                    )
                    email = None
            if member_id is not None:
                cur.execute(
                    """
                    update member set name = %s, email = coalesce(email, %s), participant_number = %s,
                        address = %s, eegfaktura_participant_id = coalesce(eegfaktura_participant_id, %s)
                    where tenant_id = %s and id = %s
                    """,
                    (p["name"], email, p["participant_number"], p["address"], p["external_id"], tenant_id, member_id),
                )
            else:
                cur.execute(
                    """
                    insert into member (tenant_id, name, email, role, participant_number, address, eegfaktura_participant_id)
                    values (%s, %s, %s, 'member', %s, %s, %s)
                    """,
                    (tenant_id, p["name"], email, p["participant_number"], p["address"], p["external_id"]),
                )
            count += 1
    return count


def link_points_to_members(conn, tenant_id, participants):
    """measurement_point.member_id anhand der Teilnehmerliste setzen.

    Zuordnung ueber die Teilnehmer-ID, fuer Teilnehmer ohne ID ueber den Namen
    (nur Zeilen ohne Teilnehmer-ID). Zaehlpunkte des Mandanten, die in keiner
    Teilnehmerliste mehr vorkommen, verlieren ihre Zuordnung (nur bei nicht
    leerer Teilnehmerliste, damit eine leere Antwort nichts loescht)."""
    with conn.cursor() as cur:
        for p in participants:
            if not p["points"]:
                continue
            if p["external_id"] is not None:
                cur.execute(
                    "select id from member where tenant_id = %s and eegfaktura_participant_id = %s order by id limit 1",
                    (tenant_id, p["external_id"]),
                )
            else:
                cur.execute(
                    "select id from member where tenant_id = %s and eegfaktura_participant_id is null and name = %s order by id limit 1",
                    (tenant_id, p["name"]),
                )
            row = cur.fetchone()
            if not row:
                continue
            cur.execute(
                "update measurement_point set member_id = %s where tenant_id = %s and metering_point = any(%s)",
                (row[0], tenant_id, [mp for mp, _ in p["points"]]),
            )
        if participants:
            listed = [mp for p in participants for mp, _ in p["points"]]
            cur.execute(
                """
                update measurement_point set member_id = null
                where tenant_id = %s and member_id is not null and not (metering_point = any(%s))
                """,
                (tenant_id, listed),
            )


def refresh_daily(conn, tenant_id, start, end):
    """Tagesaggregat measurement_daily fuer den Zeitraum [start, end] neu berechnen
    (DB-Funktion refresh_measurement_daily, lokale Tage Europe/Vienna; ein Tag Rand
    auf beiden Seiten, weil UTC-Fenster lokale Tage anschneiden). Rueckgabe: Zeilen."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select refresh_measurement_daily(%s,
                (%s at time zone 'Europe/Vienna')::date - 1,
                (%s at time zone 'Europe/Vienna')::date + 1)
            """,
            (tenant_id, start, end),
        )
        return cur.fetchone()[0]
