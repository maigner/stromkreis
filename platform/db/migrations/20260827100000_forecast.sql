-- migrate:up

-- Versionierte Prognoselaeufe je Mandant, nach dem ISCHLSTROM-Vorbild
-- (Energiegemeinschaft/notebooks/forecast/eeg_forecast.py, Modell gbt-1.1).
-- Jeder Lauf bleibt erhalten und wird nie ueberschrieben, damit Prognose und
-- spaeter nachgelieferte Messwerte verglichen werden koennen. Gerechnet wird
-- in der Pipeline (stromkreis_pipeline/forecast.py), die Plattform liest nur.
create table forecast_run (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id) on delete cascade,
    created_at timestamptz not null default now(),
    model_version text not null,
    -- letzter vollstaendiger Messtag (Europe/Vienna) zum Zeitpunkt des Laufs;
    -- die Prognose beginnt am Tag danach und fuellt auch die Luecke bis heute
    data_until date not null,
    horizon_start timestamptz not null,
    horizon_end timestamptz not null,
    training_intervals integer not null default 0,
    -- Hyperparameter und Kalibrierfaktoren des Laufs (Nachvollziehbarkeit)
    parameters jsonb,
    unique (tenant_id, id)
);

create index forecast_run_tenant_created_idx on forecast_run (tenant_id, created_at desc);

-- 15-Minuten-Werte eines Laufs: Gemeinschaftssummen in kWh je Intervall,
-- p10/p90 als Unsicherheitsband. Der Ueberschuss (surplus) ist aus den drei
-- Modellen abgeleitet (Erzeugung minus Eigendeckung, nie negativ); die
-- Punktanzahlen sind die fortgeschriebenen aktiven Zaehlpunkte, mit denen
-- die Je-Punkt-Prognose auf die Gemeinschaft hochgerechnet wurde.
create table forecast_value (
    tenant_id bigint not null,
    run_id bigint not null,
    "time" timestamptz not null,
    consumption_kwh double precision not null,
    consumption_kwh_p10 double precision,
    consumption_kwh_p90 double precision,
    generation_kwh double precision not null,
    generation_kwh_p10 double precision,
    generation_kwh_p90 double precision,
    self_coverage_kwh double precision not null,
    self_coverage_kwh_p10 double precision,
    self_coverage_kwh_p90 double precision,
    surplus_kwh double precision not null,
    surplus_kwh_p10 double precision,
    surplus_kwh_p90 double precision,
    n_consumption_points integer not null,
    n_generation_points integer not null,
    primary key (tenant_id, run_id, "time"),
    foreign key (tenant_id, run_id) references forecast_run (tenant_id, id) on delete cascade
);

-- migrate:down

drop table forecast_value;
drop table forecast_run;
