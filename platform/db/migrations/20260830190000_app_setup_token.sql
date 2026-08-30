-- migrate:up

-- Einmal-Codes fuer die Einrichtung der Stromkreis-App (QR-Code bzw. Link
-- https://stromkreis.net/app/setup/<token>). Die App loest den Token einmalig
-- gegen die Cloud-Zugangsdaten der Anlage ein (POST /api/app/setup/v1).
-- Es wird nur der SHA-256-Hash des Tokens gespeichert.
create table app_setup_token (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    site_id bigint not null,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now(),
    foreign key (tenant_id, site_id) references battery_site (tenant_id, id) on delete cascade
);

create index app_setup_token_site_idx on app_setup_token (tenant_id, site_id);

-- migrate:down

drop table app_setup_token;
