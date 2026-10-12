"""Energieprognose je Mandant: Verbrauch, Erzeugung und Eigendeckung der
Gemeinschaft je 15 Minuten, rund zwei Wochen voraus.

Portierung des ISCHLSTROM-Modells (Energiegemeinschaft/notebooks/forecast/
eeg_forecast.py, Modellversion gbt-1.1) auf die Stromkreis-Pipeline:

 - je Mandant (alle Abfragen tenant-scoped); Zielgroessen ueber
   meter_code.kind statt EEG-Faktura-Beschreibungstexten; Wetter aus der
   Tabelle weather (gepflegt von weather.py) statt eigenem Open-Meteo-Abruf;
   Sonnenstand aus tenant.latitude/longitude.
 - Drei Gradient-Boosting-Modelle (HistGradientBoostingRegressor, je ein
   Punktmodell plus q10/q90-Quantilmodelle) lernen kWh je aktivem Zaehlpunkt
   und 15 Minuten aus rein exogenen Merkmalen (Kalender, Sonnenstand,
   Wetter). Keine Autoregression: EEG-Faktura-Daten kommen mit Wochen
   Verzug, die juengste Vergangenheit ist zur Laufzeit unbekannt.
 - Der Ueberschuss ist abgeleitet (Erzeugung minus Eigendeckung), die
   Energiebilanz wird nach der Vorhersage geschlossen (Eigendeckung nie
   groesser als Verbrauch oder Erzeugung).
 - Teillieferungen: ein Tag zaehlt nur, wenn mindestens MIN_REPORTING_SHARE
   der vorhandenen Verbrauchszaehlpunkte eine Tagessumme > 0 melden und
   mindestens MIN_POINTS Zaehlpunkte vorhanden sind (Tagesbasis:
   measurement_daily). Wachstum der Gemeinschaft: normiert wird je Punkt,
   hochgerechnet mit fortgeschriebener Punktanzahl (linearer Trend der
   letzten 120 vollstaendigen Tage, nie unter dem letzten Wert).
 - Niveaudrift: exponentielle Gewichtung (Halbwertszeit 120 Tage) plus
   multiplikative Niveau-Rekalibrierung auf den letzten 14 vollstaendigen
   Tagen, out of sample geschaetzt.
 - Jeder Lauf wird versioniert gespeichert (forecast_run/forecast_value) und
   nie ueberschrieben, damit Prognose und spaeter nachgelieferte Messwerte
   verglichen werden koennen. Die Prognose beginnt am Tag nach dem letzten
   vollstaendigen Messtag und fuellt damit auch die Luecke bis heute.
"""

import logging
import os
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from . import weather as weather_mod

log = logging.getLogger(__name__)

TZ = "Europe/Vienna"
FREQ = "15min"
MODEL_VERSION = "gbt-1.1"

# Teillieferungs-Erkennung: ISCHLSTROM nutzt 0.85/30; Stromkreis-EEGs sind
# teils klein (Demo-Mandant ~10 Punkte), darum ist MIN_POINTS hier niedriger
# und per Umgebung anpassbar.
MIN_REPORTING_SHARE = float(os.environ.get("FORECAST_MIN_REPORTING_SHARE", "0.85"))
MIN_POINTS = int(os.environ.get("FORECAST_MIN_POINTS", "5"))
MIN_TRAIN_DAYS = int(os.environ.get("FORECAST_MIN_TRAIN_DAYS", "14"))

HALF_LIFE_DAYS = 120
CALIBRATION_DAYS = 14
CALIBRATION_LIMITS = (0.6, 1.6)
QUANTILES = (0.1, 0.9)
HORIZON_DAYS = 14

# Wettermerkmale = Tabellenspalten ohne snow_depth_water_equivalent (fehlt im
# ERA5-Archiv und war im ISCHLSTROM-Modell nie Merkmal)
WEATHER_FEATURES = [c for c in weather_mod.COLUMNS if c != "snow_depth_water_equivalent"]


@dataclass(frozen=True)
class Target:
    key: str      # Spaltenpraefix im Frame und in forecast_value
    kind: str     # meter_code.kind der Gemeinschaftssumme
    group: str    # Normierung: "cons" oder "gen" Punktanzahl
    solar: bool = False  # True -> 0, solange die Sonne unter dem Horizont ist


TARGETS: tuple[Target, ...] = (
    Target("consumption", "total_consumption", "cons"),
    Target("generation", "total_production", "gen", solar=True),
    Target("self_coverage", "self_use", "cons", solar=True),
)
TARGETS_BY_KEY = {t.key: t for t in TARGETS}


# ---------------------------------------------------------------------------
# Kalender: oesterreichische Feiertage und (naeherungsweise) Schulferien
# ---------------------------------------------------------------------------

def _easter(year: int) -> date:
    """Anonymer gregorianischer Algorithmus."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def austrian_holidays(years) -> set[date]:
    holidays: set[date] = set()
    for year in years:
        easter = _easter(year)
        holidays.update({
            date(year, 1, 1), date(year, 1, 6),
            easter + timedelta(days=1),   # Ostermontag
            date(year, 5, 1),
            easter + timedelta(days=39),  # Christi Himmelfahrt
            easter + timedelta(days=50),  # Pfingstmontag
            easter + timedelta(days=60),  # Fronleichnam
            date(year, 8, 15), date(year, 10, 26), date(year, 11, 1),
            date(year, 12, 8), date(year, 12, 25), date(year, 12, 26),
        })
    return holidays


def school_holidays(years) -> set[date]:
    """Schulferien in Oberoesterreich, naeherungsweise (wie ISCHLSTROM).
    Sommer: neun Wochen ab dem ersten Montag nach dem 4. Juli."""
    days: set[date] = set()

    def add_range(first: date, last: date) -> None:
        current = first
        while current <= last:
            days.add(current)
            current += timedelta(days=1)

    for year in years:
        summer_start = date(year, 7, 5)
        summer_start += timedelta(days=(7 - summer_start.weekday()) % 7)
        add_range(summer_start, summer_start + timedelta(days=62))
        add_range(date(year, 12, 24), date(year, 12, 31))
        add_range(date(year, 1, 1), date(year, 1, 6))
        semester_start = date(year, 2, 1)
        semester_start += timedelta(days=(7 - semester_start.weekday()) % 7 + 14)
        add_range(semester_start, semester_start + timedelta(days=6))
        easter = _easter(year)
        add_range(easter - timedelta(days=9), easter + timedelta(days=1))
        add_range(date(year, 10, 27), date(year, 10, 31))
    return days


# ---------------------------------------------------------------------------
# Sonnenstand (NOAA-Naeherung, ~0.01 Grad genau) und Klarhimmel-Strahlung
# ---------------------------------------------------------------------------

def solar_position(index: pd.DatetimeIndex, latitude: float, longitude: float) -> pd.DataFrame:
    n = index.tz_convert("UTC").tz_localize(None).to_julian_date().to_numpy() - 2451545.0
    mean_long = np.radians((280.460 + 0.9856474 * n) % 360)
    anomaly = np.radians((357.528 + 0.9856003 * n) % 360)
    ecliptic_long = mean_long + np.radians(1.915) * np.sin(anomaly) + np.radians(0.020) * np.sin(2 * anomaly)
    obliquity = np.radians(23.439 - 0.0000004 * n)

    declination = np.arcsin(np.sin(obliquity) * np.sin(ecliptic_long))
    right_ascension = np.arctan2(np.cos(obliquity) * np.sin(ecliptic_long), np.cos(ecliptic_long))
    gmst_hours = (18.697374558 + 24.06570982441908 * n) % 24
    local_sidereal = np.radians((gmst_hours * 15.0 + longitude) % 360)
    hour_angle = local_sidereal - right_ascension

    lat = np.radians(latitude)
    elevation = np.arcsin(
        np.sin(lat) * np.sin(declination) + np.cos(lat) * np.cos(declination) * np.cos(hour_angle)
    )
    azimuth = np.arctan2(
        -np.sin(hour_angle),
        np.tan(declination) * np.cos(lat) - np.sin(lat) * np.cos(hour_angle),
    )

    elevation_deg = np.degrees(elevation)
    sin_elev = np.clip(np.sin(elevation), 0, None)
    # Kasten-Young-Luftmasse plus einfache Klarhimmel-Transmission
    with np.errstate(divide="ignore", invalid="ignore"):
        air_mass = 1.0 / (
            sin_elev + 0.50572 * np.power(np.clip(elevation_deg, 0, None) + 6.07995, -1.6364)
        )
    clear_sky = np.where(sin_elev > 0, 1361.0 * sin_elev * np.power(0.7, np.power(air_mass, 0.678)), 0.0)

    return pd.DataFrame({
        "solar_elevation": elevation_deg,
        "solar_azimuth": np.degrees(azimuth) % 360,
        "clear_sky_ghi": np.nan_to_num(clear_sky),
    }, index=index)


def weather_to_15min(weather: pd.DataFrame, index: pd.DatetimeIndex) -> pd.DataFrame:
    """Stundenwetter auf das 15-Minuten-Modellraster interpolieren."""
    upsampled = weather.reindex(weather.index.union(index)).interpolate("time", limit=8)
    return upsampled.reindex(index).ffill(limit=4).bfill(limit=4)


def build_features(index: pd.DatetimeIndex, weather: pd.DataFrame,
                   latitude: float, longitude: float) -> pd.DataFrame:
    """Kalender-, Sonnen- und Wettermerkmale fuer einen 15-Minuten-UTC-Index."""
    local = index.tz_convert(TZ)
    features = pd.DataFrame(index=index)

    # --- Kalender ---------------------------------------------------------
    quarter = local.hour * 4 + local.minute // 15
    features["quarter_of_day"] = quarter
    day_angle = 2 * np.pi * quarter / 96
    features["tod_sin"] = np.sin(day_angle)
    features["tod_cos"] = np.cos(day_angle)
    features["tod_sin2"] = np.sin(2 * day_angle)
    features["tod_cos2"] = np.cos(2 * day_angle)

    features["day_of_week"] = local.dayofweek
    features["is_weekend"] = (local.dayofweek >= 5).astype(int)
    holidays = austrian_holidays(range(local.year.min(), local.year.max() + 2))
    is_holiday = np.array([d in holidays for d in local.date])
    features["is_holiday"] = is_holiday.astype(int)
    features["is_off_day"] = ((local.dayofweek >= 5) | is_holiday).astype(int)
    vacations = school_holidays(range(local.year.min(), local.year.max() + 2))
    features["is_school_holiday"] = np.array([d in vacations for d in local.date]).astype(int)

    year_angle = 2 * np.pi * local.dayofyear / 365.25
    features["doy_sin"] = np.sin(year_angle)
    features["doy_cos"] = np.cos(year_angle)
    features["doy_sin2"] = np.sin(2 * year_angle)
    features["doy_cos2"] = np.cos(2 * year_angle)
    features["month"] = local.month

    # --- Sonnenstand ------------------------------------------------------
    solar = solar_position(index, latitude, longitude)
    features = features.join(solar)
    features["is_day"] = (solar.solar_elevation > 0).astype(int)

    # --- Wetter -----------------------------------------------------------
    weather_15 = weather_to_15min(weather, index)
    features = features.join(weather_15)

    # --- abgeleitet -------------------------------------------------------
    clear_sky = features["clear_sky_ghi"].replace(0, np.nan)
    features["clear_sky_index"] = (features["shortwave_radiation"] / clear_sky).clip(0, 1.5).fillna(0)
    features["temp_24h"] = features["temperature_2m"].rolling(96, min_periods=8, center=True).mean()
    features["temp_min_24h"] = features["temperature_2m"].rolling(96, min_periods=8, center=True).min()
    features["temp_max_24h"] = features["temperature_2m"].rolling(96, min_periods=8, center=True).max()
    features["heating_degrees"] = (16.0 - features["temp_24h"]).clip(lower=0)
    features["cooling_degrees"] = (features["temp_24h"] - 21.0).clip(lower=0)
    features["radiation_24h"] = (
        features["shortwave_radiation"].rolling(96, min_periods=8, center=True).mean()
    )
    features["radiation_3h"] = features["shortwave_radiation"].rolling(12, min_periods=2).mean()
    features["snow_cover"] = (features["snow_depth"] > 0.01).astype(int)

    return features


# ---------------------------------------------------------------------------
# Daten laden und Panel bauen
# ---------------------------------------------------------------------------

def _load_totals(conn, tenant_id) -> pd.DataFrame:
    """Gemeinschaftssummen je 15-Minuten-Intervall und Zielgroesse."""
    kinds = [t.kind for t in TARGETS]
    with conn.cursor() as cur:
        cur.execute(
            """
            select m.measured_at, mc.kind, sum(m.value)::float8 as total
            from measurement m
            join meter_code mc on mc.tenant_id = m.tenant_id and mc.id = m.meter_code_id
            where m.tenant_id = %s and mc.kind = any(%s)
            group by 1, 2
            """,
            (tenant_id, kinds),
        )
        rows = cur.fetchall()
    frame = pd.DataFrame(rows, columns=["measured_at", "kind", "total"])
    if not frame.empty:
        frame["measured_at"] = pd.to_datetime(frame["measured_at"], utc=True)
    return frame


def _load_day_info(conn, tenant_id) -> pd.DataFrame:
    """Punktanzahlen und Vollstaendigkeit je lokalem Tag (aus measurement_daily)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select d.day,
                count(distinct d.measurement_point_id) filter (where mc.kind = 'total_consumption')::int as present,
                count(distinct d.measurement_point_id) filter (where mc.kind = 'total_consumption' and d.nonzero_intervals > 0)::int as reporting,
                count(distinct d.measurement_point_id) filter (where mc.kind = 'total_production')::int as gen_present
            from measurement_daily d
            join meter_code mc on mc.tenant_id = d.tenant_id and mc.id = d.meter_code_id
            where d.tenant_id = %s
            group by 1
            order by 1
            """,
            (tenant_id,),
        )
        rows = cur.fetchall()
    daily = pd.DataFrame(rows, columns=["day", "present", "reporting", "gen_present"]).set_index("day")
    daily.index = pd.to_datetime(daily.index)
    share = daily.reporting / daily.present.replace(0, np.nan)
    info = pd.DataFrame({
        "n_cons": daily.reporting,
        "n_gen": daily.gen_present,
        "complete": (share >= MIN_REPORTING_SHARE) & (daily.present >= MIN_POINTS),
    })
    info["n_gen"] = info.n_gen.replace(0, np.nan).ffill().fillna(0)
    return info


def _load_weather(conn, tenant_id) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(
            f'select "time", {", ".join(WEATHER_FEATURES)} from weather where tenant_id = %s order by 1',
            (tenant_id,),
        )
        rows = cur.fetchall()
    frame = pd.DataFrame(rows, columns=["time", *WEATHER_FEATURES])
    frame["time"] = pd.to_datetime(frame["time"], utc=True)
    frame = frame.set_index("time").sort_index()
    return frame.astype(float)


def build_panel(conn, tenant_id) -> pd.DataFrame | None:
    """15-Minuten-Frame (UTC-Index) mit Je-Punkt-Werten, Punktanzahlen und
    Vollstaendigkeit; None ohne Messdaten."""
    totals = _load_totals(conn, tenant_id)
    if totals.empty:
        return None
    day_info = _load_day_info(conn, tenant_id)

    wide = totals.pivot_table(index="measured_at", columns="kind", values="total")
    wide = wide.sort_index().asfreq(FREQ)

    panel = pd.DataFrame(index=wide.index)
    local_day = pd.to_datetime(panel.index.tz_convert(TZ).date)
    info = day_info.reindex(local_day)
    panel["n_cons"] = info.n_cons.to_numpy()
    panel["n_gen"] = info.n_gen.to_numpy()
    panel["complete"] = info.complete.fillna(False).to_numpy()

    for target in TARGETS:
        total = wide[target.kind] if target.kind in wide.columns else np.nan
        denom = panel.n_cons if target.group == "cons" else panel.n_gen
        panel[f"{target.key}_pp"] = np.where(denom > 0, total / denom, np.nan)

    return panel


def build_frame(conn, tenant, horizon_days: int = 16) -> pd.DataFrame | None:
    """Panel plus Merkmale, um `horizon_days` in die Zukunft verlaengert."""
    panel = build_panel(conn, tenant["id"])
    if panel is None:
        return None
    end = pd.Timestamp.now(tz="UTC").normalize() + pd.Timedelta(days=horizon_days)
    index = pd.date_range(panel.index.min(), end, freq=FREQ)
    weather = _load_weather(conn, tenant["id"])
    features = build_features(index, weather, tenant["latitude"], tenant["longitude"])
    frame = features.join(panel.reindex(index))
    frame["complete"] = frame["complete"].fillna(False).astype(bool)
    frame.attrs["feature_columns"] = list(features.columns)
    return frame


def feature_columns(frame: pd.DataFrame) -> list[str]:
    return frame.attrs["feature_columns"]


def last_complete_day(frame: pd.DataFrame) -> pd.Timestamp:
    """Letzter vollstaendiger Messtag als naive lokale Mitternacht."""
    local_days = pd.to_datetime(frame.index.tz_convert(TZ).date)
    return local_days[frame["complete"].to_numpy()].max()


# ---------------------------------------------------------------------------
# Training und Vorhersage
# ---------------------------------------------------------------------------

def _model(**kwargs) -> HistGradientBoostingRegressor:
    params = dict(
        max_iter=400,
        learning_rate=0.06,
        max_leaf_nodes=63,
        min_samples_leaf=40,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=0,
    )
    params.update(kwargs)
    return HistGradientBoostingRegressor(**params)


def training_mask(frame: pd.DataFrame, key: str, until=None) -> pd.Series:
    mask = frame["complete"] & frame[f"{key}_pp"].notna() & frame[feature_columns(frame)].notna().all(axis=1)
    if until is not None:
        mask &= frame.index < until
    return mask


def _sample_weights(index: pd.DatetimeIndex, half_life_days) -> np.ndarray | None:
    if not half_life_days:
        return None
    age_days = (index.max() - index).total_seconds() / 86400.0
    return np.power(0.5, age_days / half_life_days)


def train(frame: pd.DataFrame, until=None, keys=None, quantiles=QUANTILES,
          half_life_days=HALF_LIFE_DAYS, calibration_days=CALIBRATION_DAYS) -> dict:
    """Je Zielgroesse ein Punktmodell (plus Quantilmodelle) anpassen.

    calibration_days > 0 ergaenzt eine multiplikative Niveaukorrektur, die out
    of sample geschaetzt wird: ein Modell ohne die juengsten Wochen sagt sie
    vorher, das Verhaeltnis gemessen/vorhergesagt korrigiert das Niveau."""
    keys = keys or [t.key for t in TARGETS]
    columns = feature_columns(frame)
    models: dict[str, dict] = {}

    for key in keys:
        mask = training_mask(frame, key, until)
        index = frame.index[mask]
        X = frame.loc[mask, columns]
        y = frame.loc[mask, f"{key}_pp"]
        weights = _sample_weights(index, half_life_days)

        entry: dict = {"mean": _model().fit(X, y, sample_weight=weights), "n_train": int(mask.sum())}
        for q in quantiles:
            entry[f"q{int(q * 100)}"] = _model(loss="quantile", quantile=q, max_iter=250).fit(
                X, y, sample_weight=weights
            )
        entry["scale"] = 1.0
        models[key] = entry

        if calibration_days:
            split = index.max() - pd.Timedelta(days=calibration_days)
            fit_mask, holdout = index < split, index >= split
            if fit_mask.sum() > 96 * 60 and holdout.sum() > 96 * 7:
                warmup = {"mean": _model().fit(
                    X[fit_mask], y[fit_mask],
                    sample_weight=None if weights is None else weights[fit_mask],
                ), "scale": 1.0}
                predicted = _predict_pp({key: warmup}, key, frame, index[holdout])["mean"].sum()
                if predicted > 0:
                    ratio = float(y[holdout].sum() / predicted)
                    entry["scale"] = float(np.clip(ratio, *CALIBRATION_LIMITS))
    return models


def _predict_pp(models: dict, key: str, frame: pd.DataFrame, index: pd.DatetimeIndex) -> pd.DataFrame:
    X = frame.loc[index, feature_columns(frame)]
    target = TARGETS_BY_KEY[key]
    scale = models[key].get("scale", 1.0)
    out = {}
    for name, model in models[key].items():
        if name in ("n_train", "scale"):
            continue
        pred = np.clip(model.predict(X), 0, None) * scale
        if target.solar:
            # keine Gemeinschaftserzeugung, solange die Sonne unter dem Horizont ist
            pred = np.where(frame.loc[index, "clear_sky_ghi"].to_numpy() <= 0, 0.0, pred)
        out[name] = pred
    return pd.DataFrame(out, index=index)


def project_point_counts(panel: pd.DataFrame, index: pd.DatetimeIndex,
                         window_days: int = 120) -> pd.DataFrame:
    """Linearer Trend ueber die letzten `window_days` vollstaendigen Tage, nie
    unter dem letzten beobachteten Wert (Mitglieder kommen, sie gehen selten)."""
    daily = pd.DataFrame({
        "n_cons": panel.n_cons.to_numpy(),
        "n_gen": panel.n_gen.to_numpy(),
        "complete": panel.complete.to_numpy(),
    }, index=pd.to_datetime(panel.index.tz_convert(TZ).date))
    daily = daily[daily.complete].groupby(level=0).max()
    recent = daily.tail(window_days)
    target_days = pd.to_datetime(index.tz_convert(TZ).date)
    projected = {}
    for column in ("n_cons", "n_gen"):
        last = float(recent[column].iloc[-1])
        if len(recent) >= 2:
            days = (recent.index - recent.index[0]).days.to_numpy()
            ahead = (target_days - recent.index[0]).days.to_numpy()
            slope, intercept = np.polyfit(days, recent[column].to_numpy(dtype=float), 1)
            slope = max(slope, 0.0)
            projected[column] = np.maximum(intercept + slope * ahead, last)
        else:
            projected[column] = np.full(len(index), last)
    return pd.DataFrame(projected, index=index)


def forecast(frame: pd.DataFrame, models: dict, start=None, days: int = HORIZON_DAYS,
             point_counts=None) -> pd.DataFrame:
    """Gemeinschaftsreihen ab `start` (Standard: Tag nach dem letzten
    vollstaendigen Messtag) vorhersagen."""
    if start is None:
        start = (last_complete_day(frame) + pd.Timedelta(days=1)).tz_localize(TZ).tz_convert("UTC")
    start = pd.Timestamp(start)
    if start.tzinfo is None:
        start = start.tz_localize(TZ)
    end = start + pd.Timedelta(days=days)

    index = frame.index[(frame.index >= start) & (frame.index < end)]
    index = index[frame.loc[index, feature_columns(frame)].notna().all(axis=1)]
    if len(index) == 0:
        raise ValueError("kein Wetter fuer den angefragten Zeitraum vorhanden")

    counts = point_counts if point_counts is not None else project_point_counts(frame, index)
    result = pd.DataFrame(index=index)
    result["n_cons"] = counts.n_cons.round().astype(int)
    result["n_gen"] = counts.n_gen.round().astype(int)

    for key in models:
        target = TARGETS_BY_KEY[key]
        scale = result.n_cons if target.group == "cons" else result.n_gen
        predictions = _predict_pp(models, key, frame, index)
        for name, values in predictions.items():
            suffix = "" if name == "mean" else f"_{name}"
            result[f"{key}_pp{suffix}"] = values
            result[f"{key}_kwh{suffix}"] = values * scale

    return _close_energy_balance(result)


def _close_energy_balance(result: pd.DataFrame) -> pd.DataFrame:
    """Die Modelle sind unabhaengig angepasst; nichts hindert sie daran, mehr
    Eigendeckung vorherzusagen als Verbrauch oder Erzeugung da ist."""
    if not {"consumption_kwh", "generation_kwh", "self_coverage_kwh"} <= set(result.columns):
        return result

    cap = np.minimum(result.consumption_kwh, result.generation_kwh)
    for column in [c for c in result.columns if c.startswith("self_coverage_kwh")]:
        quantile = column.removeprefix("self_coverage_kwh")
        result[column] = np.minimum(result[column], cap)
        result[f"self_coverage_pp{quantile}"] = np.where(
            result.n_cons > 0, result[column] / result.n_cons, 0.0)

    result["surplus_kwh"] = (result.generation_kwh - result.self_coverage_kwh).clip(lower=0)
    for quantile in ("_q10", "_q90"):
        if f"generation_kwh{quantile}" in result.columns:
            result[f"surplus_kwh{quantile}"] = (
                result[f"generation_kwh{quantile}"] - result.self_coverage_kwh
            ).clip(lower=0)

    result["coverage_pct"] = 100 * result.self_coverage_kwh / result.consumption_kwh.replace(0, np.nan)
    return result


# ---------------------------------------------------------------------------
# Lauf speichern (versioniert, nie ueberschrieben)
# ---------------------------------------------------------------------------

STORED_COLUMNS = {
    "consumption_kwh": "consumption_kwh",
    "consumption_kwh_q10": "consumption_kwh_p10",
    "consumption_kwh_q90": "consumption_kwh_p90",
    "generation_kwh": "generation_kwh",
    "generation_kwh_q10": "generation_kwh_p10",
    "generation_kwh_q90": "generation_kwh_p90",
    "self_coverage_kwh": "self_coverage_kwh",
    "self_coverage_kwh_q10": "self_coverage_kwh_p10",
    "self_coverage_kwh_q90": "self_coverage_kwh_p90",
    "surplus_kwh": "surplus_kwh",
    "surplus_kwh_q10": "surplus_kwh_p10",
    "surplus_kwh_q90": "surplus_kwh_p90",
    "n_cons": "n_consumption_points",
    "n_gen": "n_generation_points",
}


def store_forecast(conn, tenant_id, frame, forecast_frame, models,
                   model_version: str = MODEL_VERSION, data_until=None) -> int:
    from psycopg.types.json import Json

    missing = [c for c in STORED_COLUMNS if c not in forecast_frame.columns]
    if missing:
        raise ValueError(f"Prognose ohne Spalten: {missing}")

    parameters = {
        "min_reporting_share": MIN_REPORTING_SHARE,
        "min_points": MIN_POINTS,
        "half_life_days": HALF_LIFE_DAYS,
        "calibration_days": CALIBRATION_DAYS,
        "n_features": len(feature_columns(frame)),
        "scale": {key: round(entry.get("scale", 1.0), 4) for key, entry in models.items()},
        "n_train": {key: entry.get("n_train") for key, entry in models.items()},
    }

    index = forecast_frame.index
    rows = [
        (timestamp.to_pydatetime(),
         *[None if pd.isna(value) else float(value)
           for value in forecast_frame.loc[timestamp, list(STORED_COLUMNS)]])
        for timestamp in index
    ]

    until = data_until if data_until is not None else last_complete_day(frame)
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into forecast_run
                (tenant_id, model_version, data_until, horizon_start, horizon_end,
                 training_intervals, parameters)
            values (%s, %s, %s, %s, %s, %s, %s)
            returning id
            """,
            (tenant_id, model_version, until.date() if hasattr(until, "date") else until,
             index.min().to_pydatetime(), index.max().to_pydatetime(),
             int(frame.complete.sum()), Json(parameters)),
        )
        run_id = cur.fetchone()[0]

        columns = ", ".join(STORED_COLUMNS.values())
        placeholders = ", ".join(["%s"] * (len(STORED_COLUMNS) + 3))
        cur.executemany(
            f'insert into forecast_value (tenant_id, run_id, "time", {columns}) '
            f"values ({placeholders})",
            [(tenant_id, run_id, *row) for row in rows],
        )
    conn.commit()
    return run_id


# ---------------------------------------------------------------------------
# Gesamtlauf je Mandant
# ---------------------------------------------------------------------------

def run_forecast(conn, tenant, days=None, horizon_days: int = 16):
    """Prognoselauf fuer einen Mandanten; liefert (run_id, None) oder
    (None, Grund), wenn die Datenlage keinen Lauf hergibt."""
    frame = build_frame(conn, tenant, horizon_days=horizon_days)
    if frame is None:
        return None, "keine Messdaten"
    if frame["temperature_2m"].notna().sum() == 0:
        return None, "keine Wetterdaten"

    complete_days = int(pd.Index(frame.index[frame["complete"]].tz_convert(TZ).date).nunique())
    if complete_days < MIN_TRAIN_DAYS:
        return None, f"nur {complete_days} vollstaendige Tage (mindestens {MIN_TRAIN_DAYS})"
    for target in TARGETS:
        if int(training_mask(frame, target.key).sum()) == 0:
            return None, f"keine Trainingsdaten fuer {target.key} ({target.kind})"

    models = train(frame)
    last = last_complete_day(frame)
    if days is None:
        # Luecke zwischen letztem vollstaendigen Messtag und heute mit
        # abdecken; weiter als das verfuegbare Wetter reicht der Lauf ohnehin
        # nicht (Intervalle ohne Wetter fallen in forecast() weg)
        today_local = pd.Timestamp.now(tz=TZ).normalize().tz_localize(None)
        days = max((today_local - last).days, 0) + horizon_days
    try:
        result = forecast(frame, models, days=days)
    except ValueError as err:
        return None, str(err)
    run_id = store_forecast(conn, tenant["id"], frame, result, models, data_until=last)
    log.info("%s: Prognoselauf %s gespeichert (%d Intervalle, Daten bis %s)",
             tenant["slug"], run_id, len(result), last.date())
    return run_id, None
