-- migrate:up

-- Gemeinsame Trigger-Funktion: updated_at automatisch pflegen
create function set_updated_at() returns trigger as $$
begin
    new.updated_at := now();
    return new;
end;
$$ language plpgsql;

-- EEG (Mandant) mit Standort fuer Wetterimport und Prognose
create table tenant (
    id bigint generated always as identity primary key,
    slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
    name text not null,
    latitude double precision not null,
    longitude double precision not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger tenant_updated_at
    before update on tenant
    for each row execute function set_updated_at();

-- Einfaches Mitgliederverzeichnis je Mandant (Admin-Pflege oder CSV-Import)
create table member (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    name text not null,
    email text,
    role text not null default 'member' check (role in ('member', 'board')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Ziel fuer zusammengesetzte FKs: erzwingt Mandanten-Konsistenz bei Referenzen
    unique (tenant_id, id),
    unique (tenant_id, email)
);

create index member_tenant_idx on member (tenant_id);

create trigger member_updated_at
    before update on member
    for each row execute function set_updated_at();

-- Zaehlpunkte je Mandant, optional einem Mitglied zugeordnet
create table measurement_point (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    member_id bigint,
    metering_point text not null, -- Zaehlpunktnummer (AT...)
    direction text not null check (direction in ('consumption', 'generation')),
    label text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, id),
    unique (tenant_id, metering_point),
    -- Zusammengesetzter FK statt member(id): ein Zaehlpunkt kann nie auf ein
    -- Mitglied eines anderen Mandanten zeigen
    foreign key (tenant_id, member_id) references member (tenant_id, id)
);

create index measurement_point_tenant_idx on measurement_point (tenant_id);
create index measurement_point_member_idx on measurement_point (tenant_id, member_id);

create trigger measurement_point_updated_at
    before update on measurement_point
    for each row execute function set_updated_at();

-- migrate:down

drop table measurement_point;
drop table member;
drop table tenant;
drop function set_updated_at();
