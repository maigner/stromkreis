"""Laden der normalisierten Records in das Plattform-Schema.

Jede Query ist mandantengefiltert. Der Upsert ist idempotent auf dem
Primaerschluessel von measurement (tenant, Zaehlpunkt, Kategorie, Intervall);
wiederholte Laeufe ueberschreiben Werte nur mit der neuesten Lieferung
(Ersatzwerte werden nachtraeglich korrigiert, deshalb das Ueberlappungsfenster
in sync.py).
"""

from .normalize import METER_CODES, METER_CODE_UNIT


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


def upsert_members(conn, tenant_id, participants):
    """Teilnehmer aus EEG-Faktura in member uebernehmen (Rolle member).

    Schluessel ist die EEG-Faktura-Teilnehmer-ID; ohne ID wird ueber den Namen
    zugeordnet. Betreiber-/Vorstandszeilen (aus dem Login) bleiben unberuehrt,
    ausser die E-Mail passt: dann bekommt die vorhandene Zeile die
    Teilnehmerdaten. Rueckgabe: Anzahl verarbeiteter Teilnehmer.
    """
    count = 0
    with conn.cursor() as cur:
        for p in participants:
            cur.execute(
                """
                select id from member
                where tenant_id = %s and (
                    (%s::text is not null and eegfaktura_participant_id = %s)
                    or (%s::text is not null and lower(email) = lower(%s))
                    or (eegfaktura_participant_id is null and name = %s)
                )
                order by (eegfaktura_participant_id = %s) desc nulls last, id
                limit 1
                """,
                (tenant_id, p["external_id"], p["external_id"], p["email"], p["email"], p["name"], p["external_id"]),
            )
            row = cur.fetchone()
            if row:
                cur.execute(
                    """
                    update member set name = %s, email = coalesce(email, %s), participant_number = %s,
                        address = %s, eegfaktura_participant_id = coalesce(%s, eegfaktura_participant_id)
                    where tenant_id = %s and id = %s
                    """,
                    (p["name"], p["email"], p["participant_number"], p["address"], p["external_id"], tenant_id, row[0]),
                )
            else:
                cur.execute(
                    """
                    insert into member (tenant_id, name, email, role, participant_number, address, eegfaktura_participant_id)
                    values (%s, %s, %s, 'member', %s, %s, %s)
                    on conflict (tenant_id, email) do update set name = excluded.name,
                        participant_number = excluded.participant_number, address = excluded.address,
                        eegfaktura_participant_id = excluded.eegfaktura_participant_id
                    """,
                    (tenant_id, p["name"], p["email"], p["participant_number"], p["address"], p["external_id"]),
                )
            count += 1
    return count


def link_points_to_members(conn, tenant_id, participants):
    """measurement_point.member_id anhand der Teilnehmerliste setzen."""
    with conn.cursor() as cur:
        for p in participants:
            if not p["points"]:
                continue
            cur.execute(
                """
                select id from member where tenant_id = %s and (
                    (%s::text is not null and eegfaktura_participant_id = %s) or name = %s)
                order by (eegfaktura_participant_id = %s) desc nulls last, id limit 1
                """,
                (tenant_id, p["external_id"], p["external_id"], p["name"], p["external_id"]),
            )
            row = cur.fetchone()
            if not row:
                continue
            cur.execute(
                "update measurement_point set member_id = %s where tenant_id = %s and metering_point = any(%s)",
                (row[0], tenant_id, [mp for mp, _ in p["points"]]),
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
