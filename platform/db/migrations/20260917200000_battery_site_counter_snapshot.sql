-- migrate:up

-- Tages-Schnappschuesse des kumulierten Einspeisezaehlers je Anlage
-- (batterie_netz_kwh aus dem Status-Push, integriert im Gateway in
-- control/core.js aus min(Batterie-Entladung, Netzeinspeisung)). Der
-- Status-Push schreibt bei jeder vollen Meldung den letzten Zaehlerstand des
-- lokalen Tages (Europe/Vienna) fort; daraus rechnet die Plattform Wochen-
-- und Monatssummen der Batterie-Netzeinspeisung (positive Tagesdeltas, ein
-- Zaehlerreset nach neuer SD-Karte zaehlt ab 0 weiter) und liefert sie dem
-- Gateway mit der Antwort auf die Statusmeldung fuer die Main UI.
create table battery_site_counter_snapshot (
    tenant_id bigint not null references tenant (id),
    site_id bigint not null,
    day date not null,
    battery_grid_kwh double precision not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, site_id, day),
    foreign key (tenant_id, site_id) references battery_site (tenant_id, id) on delete cascade
);

-- migrate:down

drop table battery_site_counter_snapshot;
