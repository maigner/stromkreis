-- migrate:up

-- Linux-Passwort (= openHAB-Admin-Passwort) und WLAN-Zugang einer Anlage
-- raus aus battery_site.status: der Status geht als Ganzes an den Browser
-- (Anlagenliste, Detailseite), die Geheimnisse haben dort nichts verloren
-- (Befund S2 der Sicherheitspruefung 9/2026). Eigene Spalten; die
-- Passwoerter sind wie inverter_secret/cloud_secret mit TOKEN_SECRET
-- verschluesselt (secrets.js, Praefix enc1:). Die Migration kopiert nur im
-- Klartext (dbmate kennt den Schluessel nicht); "admin.js secrets:encrypt"
-- verschluesselt direkt nach dem Deploy (deploy.sh ruft es auf), die
-- Plattform liest bis dahin beides (readSecret).
alter table battery_site
    add column linux_secret text,
    add column wifi_ssid text,
    add column wifi_secret text;

update battery_site set
    linux_secret = nullif(status->>'linux_password', ''),
    wifi_ssid = nullif(status->>'wifi_ssid', ''),
    wifi_secret = case when nullif(status->>'wifi_ssid', '') is null then null else status->>'wifi_password' end,
    status = status - 'linux_password' - 'wifi_ssid' - 'wifi_password';

-- migrate:down

update battery_site set status = status
    || jsonb_strip_nulls(jsonb_build_object('linux_password', linux_secret, 'wifi_ssid', wifi_ssid, 'wifi_password', wifi_secret));

alter table battery_site
    drop column linux_secret,
    drop column wifi_ssid,
    drop column wifi_secret;
