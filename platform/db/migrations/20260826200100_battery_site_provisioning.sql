-- migrate:up

-- Einrichtung einer Anlage nach dem ISCHLSTROM-Modell: die SD-Karte traegt nur
-- einen Einrichtungscode (XXXX-XXXX, 60 Tage gueltig) und die Plattform-URL;
-- das Gateway holt sich beim ersten Start per POST /api/gateway/provision/v1
-- seine Konfiguration (inkl. Anlagen-Token) und meldet den Fortschritt ueber
-- POST /api/gateway/provision/v1/result. Der Code bleibt bis zum Abschluss
-- (setup_phase = fertig) oder Ablauf gueltig, damit Neustarts wiederholen koennen.
-- Ein Gateway ist optional einem Zaehlpunkt zugeordnet (Erzeugungs- oder
-- Verbrauchs-ZP des Mitglieds), fuer die spaetere Prognose je Anlage.

alter table battery_site add column provision_code text;
alter table battery_site add column provision_expires_at timestamptz;
alter table battery_site add column provisioned_at timestamptz;
alter table battery_site add column setup_phase text not null default 'neu';
alter table battery_site add column setup_message text;
alter table battery_site add column setup_phase_at timestamptz;
alter table battery_site add column measurement_point_id bigint;
alter table battery_site add column capacity_kwh numeric(8,2);
alter table battery_site add column pv_kwp numeric(8,2);

alter table battery_site add constraint battery_site_provision_code_key unique (provision_code);
alter table battery_site add constraint battery_site_provision_code_format
    check (provision_code is null or provision_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$');
alter table battery_site add constraint battery_site_measurement_point_fkey
    foreign key (tenant_id, measurement_point_id) references measurement_point (tenant_id, id) on delete set null;

-- migrate:down

alter table battery_site drop constraint battery_site_measurement_point_fkey;
alter table battery_site drop constraint battery_site_provision_code_format;
alter table battery_site drop constraint battery_site_provision_code_key;
alter table battery_site drop column pv_kwp;
alter table battery_site drop column capacity_kwh;
alter table battery_site drop column measurement_point_id;
alter table battery_site drop column setup_phase_at;
alter table battery_site drop column setup_message;
alter table battery_site drop column setup_phase;
alter table battery_site drop column provisioned_at;
alter table battery_site drop column provision_expires_at;
alter table battery_site drop column provision_code;
