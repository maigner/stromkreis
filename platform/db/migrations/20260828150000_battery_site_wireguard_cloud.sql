-- migrate:up

-- WireGuard-Fernwartung und Stromkreis-eigene openHAB-Cloud je Anlage.
-- wg_address: eindeutige Tunnel-IP (Pool WG_SUBNET_PREFIX, plattformweit,
-- der WireGuard-Container am Server ist .1); wg_public_key meldet der Pi
-- bei der Einrichtung (Phase tunnel), der WireGuard-Container liest die
-- Peers ueber /api/gateway/sync/wireguard-peers.
-- cloud_*: Identitaet und Konto der Anlage auf der Stromkreis-Cloud
-- (hac.stromkreis.net). cloud_secret und cloud_password liegen mit
-- TOKEN_SECRET verschluesselt (enc1:..., lib/server/secrets.js);
-- cloud_account_state steuert den Konten-Sync im Cloud-Container:
-- pending/reset -> anlegen bzw. Passwort setzen, created, error
-- (Text in cloud_account_error), delete -> Konto entfernen.
alter table battery_site
    add column wg_address text,
    add column wg_public_key text,
    add column cloud_uuid text,
    add column cloud_secret text,
    add column cloud_username text,
    add column cloud_password text,
    add column cloud_account_state text not null default '',
    add column cloud_account_error text,
    add constraint battery_site_wg_address_key unique (wg_address),
    add constraint battery_site_cloud_state_check
        check (cloud_account_state in ('', 'pending', 'reset', 'created', 'error', 'delete'));

-- migrate:down

alter table battery_site
    drop column wg_address,
    drop column wg_public_key,
    drop column cloud_uuid,
    drop column cloud_secret,
    drop column cloud_username,
    drop column cloud_password,
    drop column cloud_account_state,
    drop column cloud_account_error;
