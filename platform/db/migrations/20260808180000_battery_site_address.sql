-- migrate:up

-- Anschrift der Anlage (Anzeige auf Anlagen-Karten und Standorte-Karte)
alter table battery_site add column address text;

-- migrate:down

alter table battery_site drop column address;
