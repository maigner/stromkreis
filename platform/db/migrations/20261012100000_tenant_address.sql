-- migrate:up

-- Adresse des Mandanten (aus dem EEG-Stammsatz von EEG-Faktura, PLZ und Ort,
-- wenn vorhanden Strasse): der Worker geokodiert sie (geocode.py, Nominatim)
-- und setzt latitude/longitude, sobald address von geocoded_address abweicht.
-- Ersetzt die Ortstabelle mit Bad Ischl als Vorgabe (Befund S7 der
-- Sicherheitspruefung 9/2026): bis zur Geokodierung steht ein Mandant auf
-- der Mitte Oesterreichs statt auf einem falschen Ort.
alter table tenant
    add column address text,
    add column geocoded_address text,
    add column geocoded_at timestamptz;

-- migrate:down

alter table tenant
    drop column address,
    drop column geocoded_address,
    drop column geocoded_at;
