-- migrate:up

-- Standort der Anlage fuer die Standorte-Karte im Dashboard
alter table battery_site add column latitude double precision;
alter table battery_site add column longitude double precision;

-- migrate:down

alter table battery_site drop column longitude;
alter table battery_site drop column latitude;
