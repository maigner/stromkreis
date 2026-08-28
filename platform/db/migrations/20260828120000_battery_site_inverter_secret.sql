-- migrate:up

-- Zugangsdaten des Wechselrichters (z. B. Fronius GEN24, Benutzer "customer"):
-- der Betreiber traegt sie auf der Anlagen-Detailseite ein, das Gateway holt
-- sie einmalig ueber POST /api/gateway/provision/v1/secret ab, danach wird
-- inverter_secret geloescht (das Passwort liegt dann nur noch am Gateway).
alter table battery_site
    add column inverter_username text,
    add column inverter_secret text;

-- migrate:down

alter table battery_site
    drop column inverter_username,
    drop column inverter_secret;
