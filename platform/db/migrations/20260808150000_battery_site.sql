-- migrate:up

-- Batterie-Anlagen: openHABian-Gateways beim Mitglied. Das Gateway pusht
-- seinen Status ausschliesslich ausgehend per HTTPS mit Anlagen-Token
-- (nur SHA-256-Hash gespeichert); der letzte Push liegt in status und
-- last_seen_at. Eine Verlaufstabelle fuer Diagramme folgt mit der IBM-API
-- (Phase 2, vgl. members_openhabstatushistory in ISCHLSTROM).
create table battery_site (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    member_id bigint,
    name text not null, -- Anzeigename der Anlage
    inverter_profile text not null, -- Wechselrichterprofil, z.B. 'fronius-symo', 'sigenergy', 'deye', 'victron'
    token_hash text not null unique,
    last_seen_at timestamptz,
    status jsonb not null default '{}'::jsonb, -- letzter Status-Push (soc, Leistungswerte, Versionen)
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, id),
    unique (tenant_id, name),
    -- Zusammengesetzter FK: eine Anlage kann nie auf ein Mitglied eines
    -- anderen Mandanten zeigen
    foreign key (tenant_id, member_id) references member (tenant_id, id)
);

create index battery_site_tenant_idx on battery_site (tenant_id);

create trigger battery_site_updated_at
    before update on battery_site
    for each row execute function set_updated_at();

-- migrate:down

drop table battery_site;
