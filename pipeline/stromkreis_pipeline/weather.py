"""Open-Meteo-Wetterimport je Mandant, Standort aus tenant.latitude/longitude.

Nach dem ISCHLSTROM-Vorbild (Energiegemeinschaft/notebooks/weather/
backfill_openmeteo.py), aber mandantenfaehig in die Tabelle weather
(Primaerschluessel tenant_id + time, Stundenwerte als UTC-Zeitpunkte):

 - Erstbefuellung aus dem ERA5-Archiv (hinkt rund 5 Tage nach) in
   180-Tage-Stuecken, ab dem Tag vor dem ersten Messwert des Mandanten
   (ohne Messwerte: 92 Tage zurueck).
 - Danach je Lauf nur der Forecast-Endpunkt: past_days=92 liefert das
   tatsaechlich eingetretene Wetter der letzten Wochen (ueberschreibt damit
   auch aeltere Prognosestunden, sobald sie Vergangenheit sind) plus bis zu
   16 Tage Vorhersage fuer den Prognoselauf.

Stunden, in denen eine der NOT-NULL-Spalten fehlt, werden uebersprungen
(Open-Meteo liefert am Rand des Horizonts teils Luecken).
"""

import logging
from datetime import date, timedelta

import requests

log = logging.getLogger(__name__)

FORECAST_API = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive"

# Spalten der Tabelle weather in Einfuegereihenfolge; die ersten zehn sind
# dort NOT NULL (Pflichtwerte), der Rest darf fehlen.
COLUMNS = [
    "temperature_2m", "cloud_cover", "rain", "snowfall", "snow_depth",
    "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
    "relative_humidity_2m", "dew_point_2m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance", "sunshine_duration",
    "wind_speed_10m", "precipitation", "apparent_temperature",
    "snow_depth_water_equivalent",
]
REQUIRED = COLUMNS[:10]


def load_tenants(conn, slug=None, tenant_id=None):
    """Mandanten samt Standort; optional auf einen Slug oder eine Id begrenzt."""
    query = "select id, slug, name, latitude, longitude from tenant"
    params = []
    if slug is not None:
        query += " where slug = %s"
        params.append(slug)
    elif tenant_id is not None:
        query += " where id = %s"
        params.append(tenant_id)
    query += " order by slug"
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return [
        {"id": r[0], "slug": r[1], "name": r[2], "latitude": r[3], "longitude": r[4]}
        for r in rows
    ]


def _fetch(url, params, variables):
    resp = requests.get(url, params={**params, "hourly": ",".join(variables), "timezone": "UTC"}, timeout=120)
    resp.raise_for_status()
    hourly = resp.json()["hourly"]
    rows = []
    for i, ts in enumerate(hourly["time"]):
        # Open-Meteo liefert "JJJJ-MM-TTTHH:MM" in UTC (so angefordert)
        row = {"time": f"{ts}:00+00:00" if len(ts) == 16 else f"{ts}+00:00"}
        for column in COLUMNS:
            values = hourly.get(column)
            row[column] = values[i] if values is not None else None
        rows.append(row)
    return rows


def fetch_archive(tenant, start, end):
    # snow_depth_water_equivalent gibt es im ERA5-Archiv nicht
    variables = [c for c in COLUMNS if c != "snow_depth_water_equivalent"]
    return _fetch(ARCHIVE_API, {
        "latitude": tenant["latitude"], "longitude": tenant["longitude"],
        "start_date": str(start), "end_date": str(end),
    }, variables)


def fetch_recent(tenant, past_days, forecast_days):
    return _fetch(FORECAST_API, {
        "latitude": tenant["latitude"], "longitude": tenant["longitude"],
        "past_days": min(past_days, 92), "forecast_days": forecast_days,
    }, COLUMNS)


def upsert(conn, tenant_id, rows):
    """Stunden einspielen; Zeilen ohne Pflichtwerte werden uebersprungen."""
    rows = [r for r in rows if all(r.get(c) is not None for c in REQUIRED)]
    if not rows:
        return 0
    cols = ", ".join(COLUMNS)
    updates = ", ".join(f"{c} = excluded.{c}" for c in COLUMNS)
    placeholders = ", ".join(["%s"] * (len(COLUMNS) + 2))
    with conn.cursor() as cur:
        cur.executemany(
            f'insert into weather (tenant_id, "time", {cols}) values ({placeholders}) '
            f'on conflict (tenant_id, "time") do update set {updates}',
            [(tenant_id, r["time"], *[r[c] for c in COLUMNS]) for r in rows],
        )
    conn.commit()
    return len(rows)


def import_weather(conn, tenant, forecast_days=16):
    """Wetter eines Mandanten aktualisieren; liefert die Zahl geschriebener Stunden."""
    with conn.cursor() as cur:
        cur.execute("select min(measured_at) from measurement where tenant_id = %s", (tenant["id"],))
        first_measure = cur.fetchone()[0]
        cur.execute('select min("time") from weather where tenant_id = %s', (tenant["id"],))
        have_min = cur.fetchone()[0]
    today = date.today()
    needed_start = first_measure.date() - timedelta(days=1) if first_measure else today - timedelta(days=92)
    archive_end = today - timedelta(days=6)
    written = 0

    # Archiv nur zur Erstbefuellung bzw. wenn vorne Historie fehlt; die
    # letzten 92 Tage pflegt ohnehin der Forecast-Endpunkt unten.
    if (have_min is None or have_min.date() > needed_start) and needed_start <= archive_end:
        chunk_start = needed_start
        while chunk_start <= archive_end:
            chunk_end = min(chunk_start + timedelta(days=179), archive_end)
            written += upsert(conn, tenant["id"], fetch_archive(tenant, chunk_start, chunk_end))
            log.info("%s: Wetterarchiv %s bis %s geladen", tenant["slug"], chunk_start, chunk_end)
            chunk_start = chunk_end + timedelta(days=1)

    written += upsert(conn, tenant["id"], fetch_recent(tenant, past_days=92, forecast_days=forecast_days))
    return written
