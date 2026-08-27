"""Tests der Prognose-Kernfunktionen (ohne DB): Kalender, Sonnenstand,
Wetter-Interpolation, Energiebilanz und ein synthetischer Train/Forecast-Lauf."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from stromkreis_pipeline import forecast as fc

LAT, LON = 47.7126, 13.6197  # Bad Ischl (Seed-Standort Salzkammerstrom)


def test_easter():
    assert fc._easter(2024) == date(2024, 3, 31)
    assert fc._easter(2026) == date(2026, 4, 5)


def test_austrian_holidays():
    holidays = fc.austrian_holidays([2026])
    assert date(2026, 1, 1) in holidays
    assert date(2026, 10, 26) in holidays
    assert date(2026, 4, 6) in holidays  # Ostermontag
    assert date(2026, 5, 14) in holidays  # Christi Himmelfahrt
    assert date(2026, 10, 27) not in holidays


def test_school_holidays_summer():
    vacations = fc.school_holidays([2026])
    assert date(2026, 8, 1) in vacations
    assert date(2026, 5, 20) not in vacations


def test_solar_position_summer_noon():
    index = pd.DatetimeIndex([pd.Timestamp("2026-06-21 11:00", tz="UTC")])  # ~13:00 lokal, nahe Sonnenhoechststand
    solar = fc.solar_position(index, LAT, LON)
    assert 60 < solar.solar_elevation.iloc[0] < 70
    assert solar.clear_sky_ghi.iloc[0] > 600


def test_solar_position_night():
    index = pd.DatetimeIndex([pd.Timestamp("2026-06-21 23:00", tz="UTC")])
    solar = fc.solar_position(index, LAT, LON)
    assert solar.solar_elevation.iloc[0] < 0
    assert solar.clear_sky_ghi.iloc[0] == 0


def test_weather_to_15min_interpolates():
    hourly = pd.DataFrame(
        {"temperature_2m": [10.0, 12.0]},
        index=pd.DatetimeIndex([pd.Timestamp("2026-08-27 10:00", tz="UTC"), pd.Timestamp("2026-08-27 11:00", tz="UTC")]),
    )
    index = pd.date_range("2026-08-27 10:00", "2026-08-27 11:00", freq="15min", tz="UTC")
    result = fc.weather_to_15min(hourly, index)
    assert result.temperature_2m.tolist() == [10.0, 10.5, 11.0, 11.5, 12.0]


def test_close_energy_balance_caps_self_coverage():
    result = pd.DataFrame({
        "n_cons": [10, 10],
        "n_gen": [3, 3],
        "consumption_kwh": [5.0, 8.0],
        "generation_kwh": [3.0, 10.0],
        "self_coverage_kwh": [4.0, 9.0],  # 1. Wert groesser als Erzeugung, 2. groesser als noetig erlaubt
    })
    closed = fc._close_energy_balance(result)
    assert closed.self_coverage_kwh.tolist() == [3.0, 8.0]
    assert closed.surplus_kwh.tolist() == [0.0, 2.0]
    assert closed.coverage_pct.iloc[1] == pytest.approx(100.0)


def _synthetic_frame(train_days=30, future_days=7):
    """Frame wie aus build_frame, aber rein synthetisch: sonnengetriebene
    Erzeugung, tagesrhythmischer Verbrauch, konstante Punktanzahlen."""
    end = pd.Timestamp("2026-08-20", tz="UTC")
    start = end - pd.Timedelta(days=train_days)
    index = pd.date_range(start, end + pd.Timedelta(days=future_days), freq="15min")

    hourly_index = pd.date_range(index.min(), index.max(), freq="1h")
    solar_h = fc.solar_position(hourly_index, LAT, LON)
    rng = np.random.default_rng(0)
    weather = pd.DataFrame(index=hourly_index)
    weather["temperature_2m"] = 18 + 6 * np.sin(2 * np.pi * (hourly_index.hour - 9) / 24)
    weather["shortwave_radiation"] = solar_h.clear_sky_ghi.to_numpy() * 0.8
    weather["cloud_cover"] = 20.0
    for column in fc.WEATHER_FEATURES:
        if column not in weather.columns:
            weather[column] = rng.uniform(0, 1, len(hourly_index))
    weather = weather[fc.WEATHER_FEATURES]

    frame = fc.build_features(index, weather, LAT, LON)
    frame.attrs["feature_columns"] = list(frame.columns)

    past = index < end
    ghi = frame["clear_sky_ghi"].to_numpy()
    local_hour = index.tz_convert(fc.TZ).hour
    frame["n_cons"] = 10.0
    frame["n_gen"] = 3.0
    frame["complete"] = past
    frame["consumption_pp"] = np.where(past, 0.05 + 0.03 * np.sin(2 * np.pi * (local_hour - 19) / 24) ** 2, np.nan)
    frame["generation_pp"] = np.where(past, 0.4 * ghi / 1000, np.nan)
    frame["self_coverage_pp"] = np.where(past, np.minimum(0.05, 0.12 * ghi / 1000), np.nan)
    return frame, end


def test_train_and_forecast_synthetic():
    frame, end = _synthetic_frame()
    models = fc.train(frame, calibration_days=0)
    assert set(models) == {"consumption", "generation", "self_coverage"}
    assert models["consumption"]["n_train"] > 96 * 20

    result = fc.forecast(frame, models, start=end, days=7)
    assert len(result) == 96 * 7
    for column in fc.STORED_COLUMNS:
        assert column in result.columns
    # Nachts keine Erzeugung, untertags schon; Bilanz geschlossen
    night = result[result.index.tz_convert(fc.TZ).hour == 2]
    noon = result[result.index.tz_convert(fc.TZ).hour == 12]
    assert night.generation_kwh.max() == 0
    assert noon.generation_kwh.mean() > 0
    assert (result.self_coverage_kwh <= np.minimum(result.consumption_kwh, result.generation_kwh) + 1e-9).all()
    assert (result.surplus_kwh >= 0).all()
    assert result.consumption_kwh.mean() > 0


def test_project_point_counts_growth_floor():
    index = pd.date_range("2026-08-01", periods=8, freq="15min", tz="UTC")
    days = pd.date_range("2026-07-01", periods=20, freq="D", tz="UTC")
    panel = pd.DataFrame({
        "n_cons": np.linspace(5, 12, len(days)).round(),
        "n_gen": 3.0,
        "complete": True,
    }, index=days)
    counts = fc.project_point_counts(panel, index)
    assert (counts.n_cons >= 12).all()  # nie unter dem letzten Wert
    assert (counts.n_gen == 3).all()
