-- migrate:up

-- Betreiber-Login "Anmelden mit EEGFaktura" (OIDC gegen die EEG-Faktura-Keycloak,
-- Authorization Code + PKCE) und der daraus angestossene Hintergrund-Import.
--
-- Identitaet: die Keycloak-Identitaet (sub) wird je Mandant auf eine member-Zeile
-- mit Rolle operator abgebildet (Schluessel ist die E-Mail, wie beim Magic-Link).
-- Ein Benutzer mit mehreren EEGs im tenant-Claim bekommt je EEG einen Mandanten
-- (beim ersten Login automatisch angelegt) und eine member-Zeile.

alter table member add column oidc_sub text;
comment on column member.oidc_sub is 'Keycloak-Subject der EEG-Faktura-Identitaet, beim ersten OIDC-Login gesetzt';
create index member_oidc_sub_idx on member (oidc_sub) where oidc_sub is not null;

-- Teilnehmerdaten aus EEG-Faktura (GET /api/participant), vom Import gepflegt.
alter table member add column participant_number text;
alter table member add column address text;
alter table member add column eegfaktura_participant_id text;
create unique index member_eegfaktura_participant_idx
    on member (tenant_id, eegfaktura_participant_id) where eegfaktura_participant_id is not null;

-- Dritter Auth-Weg fuer den Import: Bearer-Token aus dem Refresh-Token des
-- angemeldeten Betreibers (Keycloak offline_access). Kein Secret in der .env.
alter table eegfaktura_source drop constraint eegfaktura_source_auth_mode_check;
alter table eegfaktura_source add constraint eegfaktura_source_auth_mode_check
    check (auth_mode in ('basic', 'client_credentials', 'oidc'));

-- Refresh-Token je Mandant, verschluesselt (AES-256-GCM mit TOKEN_SECRET aus der
-- Server-.env; Format enc1:<iv b64>:<ct+tag b64>, Plattform und Pipeline teilen sich
-- Schluessel und Format). Wird beim Login erneuert und vom Worker nach jedem
-- Refresh aktualisiert (Keycloak rotiert hier nicht, revokeRefreshToken=false).
create table eegfaktura_oidc_token (
    tenant_id bigint primary key references tenant (id) on delete cascade,
    member_id bigint not null,
    issuer text not null,
    client_id text not null,
    refresh_token_enc text not null,
    scope text,
    refreshed_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (tenant_id, member_id) references member (tenant_id, id) on delete cascade
);

create trigger eegfaktura_oidc_token_updated_at
    before update on eegfaktura_oidc_token
    for each row execute function set_updated_at();

-- Import-Auftraege. Die Plattform stellt beim Login einen Auftrag ein, der
-- Pipeline-Worker (pipeline/, Container "worker") arbeitet ihn ab: erst
-- Teilnehmer und Zaehlpunkte (Phase masterdata), dann Energiedaten in
-- 30-Tage-Stuecken mit Pause dazwischen (Phase energy), bewusst langsam.
-- progress: jsonb mit chunk_start/chunk_end/rows/points/period_begin/period_end.
create table eegfaktura_sync_job (
    id bigint generated always as identity primary key,
    tenant_id bigint not null references tenant (id) on delete cascade,
    phase text not null default 'queued'
        check (phase in ('queued', 'masterdata', 'energy', 'done', 'error')),
    full_import boolean not null default false,
    progress jsonb not null default '{}',
    error text,
    requested_by bigint,
    requested_at timestamptz not null default now(),
    started_at timestamptz,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    foreign key (tenant_id, requested_by) references member (tenant_id, id) on delete set null
);

create index eegfaktura_sync_job_tenant_idx on eegfaktura_sync_job (tenant_id, requested_at desc);
create index eegfaktura_sync_job_queue_idx on eegfaktura_sync_job (requested_at)
    where phase in ('queued', 'masterdata', 'energy');

-- migrate:down

drop table eegfaktura_sync_job;
drop table eegfaktura_oidc_token;
alter table eegfaktura_source drop constraint eegfaktura_source_auth_mode_check;
alter table eegfaktura_source add constraint eegfaktura_source_auth_mode_check
    check (auth_mode in ('basic', 'client_credentials'));
drop index member_eegfaktura_participant_idx;
alter table member drop column eegfaktura_participant_id;
alter table member drop column address;
alter table member drop column participant_number;
drop index member_oidc_sub_idx;
alter table member drop column oidc_sub;
