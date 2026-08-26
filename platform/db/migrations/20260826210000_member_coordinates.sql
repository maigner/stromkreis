-- migrate:up
-- Koordinaten der Mitglieder: der Worker geokodiert die Adresse aus EEG-Faktura
-- (Nominatim) nach jedem Mitgliederimport, wenn sich die Adresse geaendert hat.
-- geocoded_address ist die Adresse, fuer die latitude/longitude gelten (auch bei
-- Fehlschlag gesetzt, damit nicht bei jedem Import erneut angefragt wird).
alter table member
    add column latitude double precision,
    add column longitude double precision,
    add column geocoded_address text,
    add column geocoded_at timestamptz;
comment on column member.geocoded_address is 'Adresse, auf die sich latitude/longitude beziehen; weicht sie von address ab, geokodiert der Worker neu';

-- migrate:down
alter table member
    drop column latitude,
    drop column longitude,
    drop column geocoded_address,
    drop column geocoded_at;
