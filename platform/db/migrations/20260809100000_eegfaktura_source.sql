-- migrate:up

-- Zugangskonfiguration je Mandant fuer den EEG-Faktura-Import (nur
-- Nicht-Geheimes). Secrets liegen ausschliesslich in der Server-.env:
-- EEGFAKTURA_<SLUG>_USER / _PASSWORD (auth_mode basic) bzw.
-- EEGFAKTURA_<SLUG>_CLIENT_ID / _CLIENT_SECRET (auth_mode client_credentials),
-- Slug grossgeschrieben und '-' durch '_' ersetzt. Mandanten ohne Zeile (oder
-- mit active=false) ueberspringt der Importer. Details: docs/eegfaktura-api.md
create table eegfaktura_source (
    tenant_id bigint primary key references tenant (id),
    rc_number text not null check (rc_number = upper(rc_number)), -- Tenant bei EEG-Faktura, Vergleich dort grossgeschrieben
    base_url text not null default 'https://eegfaktura.at',
    auth_mode text not null check (auth_mode in ('basic', 'client_credentials')),
    token_url text, -- nur fuer client_credentials; null = Standard-Keycloak login.eegfaktura.at (setzt die Pipeline)
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger eegfaktura_source_updated_at
    before update on eegfaktura_source
    for each row execute function set_updated_at();

-- Datenqualitaet je Wert, qov aus der Energystore-API: 1 gemessen,
-- 2 Ersatzwert, 3 geschaetzt, 0 unbekannt. Null bei Quellen ohne
-- Qualitaetsangabe (Excel-Export, Demo-Generator). Grundlage fuer das
-- Meldeanteil-Gate der Prognose (Tage erst ab Mindestanteil meldender
-- Zaehlpunkte vertrauen).
alter table measurement add column quality smallint
    check (quality between 0 and 3);

-- migrate:down

alter table measurement drop column quality;
drop table eegfaktura_source;
