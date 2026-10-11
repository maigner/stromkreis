-- migrate:up

-- Einrichtungscode mit drei statt zwei Vierergruppen (60 statt 40 Bit,
-- Befund S3 der Sicherheitspruefung 9/2026). Bestehende Codes mit zwei
-- Gruppen bleiben bis Ablauf bzw. "Neuer Code" gueltig, daher beide Formen.
alter table battery_site drop constraint battery_site_provision_code_format;
alter table battery_site add constraint battery_site_provision_code_format
    check (provision_code is null or provision_code ~ '^[A-Z0-9]{4}(-[A-Z0-9]{4}){1,2}$');

-- migrate:down

-- Zurueck geht nur ohne lange Codes: die werden verworfen (Betreiber
-- erzeugt bei Bedarf "Neuer Code").
update battery_site set provision_code = null, provision_expires_at = null
    where provision_code is not null and provision_code !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$';
alter table battery_site drop constraint battery_site_provision_code_format;
alter table battery_site add constraint battery_site_provision_code_format
    check (provision_code is null or provision_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$');
