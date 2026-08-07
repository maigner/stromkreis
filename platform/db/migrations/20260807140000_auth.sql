-- migrate:up

-- Einmal-Login-Links (Invite bzw. spaeter Magic-Link per E-Mail).
-- Es wird nur der SHA-256-Hash des Tokens gespeichert.
create table login_token (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    member_id bigint not null,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now(),
    foreign key (tenant_id, member_id) references member (tenant_id, id) on delete cascade
);

create index login_token_member_idx on login_token (tenant_id, member_id);

create table session (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id),
    member_id bigint not null,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    foreign key (tenant_id, member_id) references member (tenant_id, id) on delete cascade
);

create index session_member_idx on session (tenant_id, member_id);

-- migrate:down

drop table session;
drop table login_token;
