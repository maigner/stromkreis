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
