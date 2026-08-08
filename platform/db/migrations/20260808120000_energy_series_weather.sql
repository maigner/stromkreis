-- migrate:up

-- Energiekategorien aus EEG-Faktura ("Meter Codes"), je Mandant beim Import
-- angelegt (Beschreibung und Einheit werden aus dem Lieferkopf geparst,
-- z.B. "Gesamtverbrauch lt. Messung (bei Teilnahme gem. Erzeugung) [kWh]").
-- "kind" ist der stabile Schluessel fuer Dashboards und Prognose; der Import
-- setzt ihn fuer bekannte Beschreibungen. Unbekannte Kategorien bleiben null
-- und werden nur gespeichert. Kein Unique auf (tenant_id, kind): aendert sich
-- eine Beschreibung im Export, entsteht eine zweite Zeile mit gleichem kind,
-- Auswertungen summieren ueber kind.
create table meter_code (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    description text not null,
    unit text not null, -- wie geliefert, produktiv "kWh"
    kind text check (kind in (
        'total_consumption', -- Gesamtverbrauch lt. Messung
        'production_share',  -- Anteil gemeinschaftliche Erzeugung (gesamte Gemeinschaftserzeugung, auf Verbraucherseite gezaehlt)
        'self_use',          -- Eigendeckung gemeinschaftliche Erzeugung (tatsaechlich verbrauchter Anteil)
        'total_production',  -- Gesamte gemeinschaftliche Erzeugung
        'overshoot'          -- Gemeinschaftsueberschuss (Einspeisung ins Netz)
    )),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, id),
    unique (tenant_id, description, unit)
);

create index meter_code_tenant_idx on meter_code (tenant_id);

create trigger meter_code_updated_at
    before update on meter_code
    for each row execute function set_updated_at();

-- 15-Minuten-Reihen aus EEG-Faktura: eine Zeile je Zaehlpunkt, Kategorie und
-- Intervall. measured_at ist der Intervallbeginn als UTC-Instant; der Import
-- lokalisiert die gelieferte Wandzeit in Europe/Vienna. Das 15-Minuten-Raster
-- ist implizit (96 Intervalle je Tag). value ist die Energie im Intervall in
-- der Einheit des meter_code (produktiv kWh).
create table measurement (
    tenant_id bigint not null references tenant (id),
    measurement_point_id bigint not null,
    meter_code_id bigint not null,
    measured_at timestamptz not null,
    value numeric(19, 10) not null,
    primary key (tenant_id, measurement_point_id, meter_code_id, measured_at),
    -- Zusammengesetzte FKs: Reihen koennen nie auf Zaehlpunkt oder Kategorie
    -- eines anderen Mandanten zeigen. Zaehlpunkt loeschen loescht seine Reihen;
    -- eine Kategorie mit Daten laesst sich nicht loeschen.
    foreign key (tenant_id, measurement_point_id) references measurement_point (tenant_id, id) on delete cascade,
    foreign key (tenant_id, meter_code_id) references meter_code (tenant_id, id)
);

-- Gemeinschaftsweite Zeitfenster-Abfragen (Dashboards, Aggregation, Prognose)
create index measurement_tenant_time_idx on measurement (tenant_id, measured_at);

-- Stundenwetter je Mandant von Open-Meteo (Standort: tenant.latitude/longitude).
-- time ist der Stundenbeginn als UTC-Instant. Die Pflichtfelder entsprechen der
-- REQUIRED-Liste der ISCHLSTROM-Loader: Stunden, denen eines fehlt, werden beim
-- Import uebersprungen. Die Prognose interpoliert stuendlich auf 15 Minuten.
create table weather (
    tenant_id bigint not null references tenant (id),
    time timestamptz not null,
    temperature_2m double precision not null,               -- Grad Celsius
    cloud_cover double precision not null,                  -- %
    rain double precision not null,                         -- mm
    snowfall double precision not null,                     -- cm
    snow_depth double precision not null,                   -- m
    cloud_cover_low double precision not null,              -- %
    cloud_cover_mid double precision not null,              -- %
    cloud_cover_high double precision not null,             -- %
    relative_humidity_2m double precision not null,         -- %
    dew_point_2m double precision not null,                 -- Grad Celsius
    shortwave_radiation double precision,                   -- W/m2 (Globalstrahlung)
    direct_radiation double precision,                      -- W/m2
    diffuse_radiation double precision,                     -- W/m2
    direct_normal_irradiance double precision,              -- W/m2
    sunshine_duration double precision,                     -- s je Stunde
    wind_speed_10m double precision,                        -- km/h
    precipitation double precision,                         -- mm (Regen + Schauer + Schnee)
    apparent_temperature double precision,                  -- Grad Celsius
    snow_depth_water_equivalent double precision,           -- mm (nur AROME, bewusst getrennt von snow_depth)
    primary key (tenant_id, time)
);

-- migrate:down

drop table weather;
drop table measurement;
drop table meter_code;
