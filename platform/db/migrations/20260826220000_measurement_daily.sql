-- migrate:up
-- Tagesaggregat der 15-Minuten-Messwerte je Zaehlpunkt und Kategorie, lokaler Tag
-- Europe/Vienna. Grundlage des Tabs "Energie" (Auswertungen ueber Monate und Jahre
-- waren auf den Rohdaten mit Millionen Zeilen je Mandant zu langsam).
-- Gepflegt von der Pipeline: nach jedem Import-Stueck refresh_measurement_daily()
-- fuer den geladenen Zeitraum (loeschen und neu einfuegen, daher idempotent).
create table measurement_daily (
    tenant_id bigint not null references tenant (id),
    measurement_point_id bigint not null,
    meter_code_id bigint not null,
    day date not null,
    kwh numeric(14, 4) not null,
    intervals integer not null,
    nonzero_intervals integer not null,
    primary key (tenant_id, measurement_point_id, meter_code_id, day),
    foreign key (tenant_id, measurement_point_id) references measurement_point (tenant_id, id) on delete cascade,
    foreign key (tenant_id, meter_code_id) references meter_code (tenant_id, id)
);
create index measurement_daily_tenant_day_idx on measurement_daily (tenant_id, day);
comment on table measurement_daily is 'Tagessummen (kWh) je Zaehlpunkt und Kategorie, lokaler Tag Europe/Vienna; aus measurement per refresh_measurement_daily()';
comment on column measurement_daily.intervals is 'Anzahl 15-Minuten-Werte des Tages (96 = vollstaendig)';
comment on column measurement_daily.nonzero_intervals is 'davon Werte > 0 (Teillieferungen erkennen)';

-- Tagesaggregat fuer einen Mandanten und Tagesbereich (inklusive) neu berechnen.
-- Rueckgabe: Anzahl geschriebener Zeilen.
create function refresh_measurement_daily(p_tenant bigint, p_from date, p_to date) returns integer
language plpgsql as $$
declare
    n integer;
begin
    delete from measurement_daily where tenant_id = p_tenant and day between p_from and p_to;
    insert into measurement_daily (tenant_id, measurement_point_id, meter_code_id, day, kwh, intervals, nonzero_intervals)
    select tenant_id, measurement_point_id, meter_code_id,
        (measured_at at time zone 'Europe/Vienna')::date,
        sum(value), count(*)::integer, count(*) filter (where value > 0)::integer
    from measurement
    where tenant_id = p_tenant
        and measured_at >= p_from::timestamp at time zone 'Europe/Vienna'
        and measured_at < (p_to + 1)::timestamp at time zone 'Europe/Vienna'
    group by 1, 2, 3, 4;
    get diagnostics n = row_count;
    return n;
end
$$;

-- migrate:down
drop function refresh_measurement_daily(bigint, date, date);
drop table measurement_daily;
