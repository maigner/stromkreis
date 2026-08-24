-- migrate:up

-- Der energystore legt die Energiedaten je Tenant (RC-Nummer, Header X-Tenant)
-- UND je Gemeinschafts-ID ab (AT...-33 Zeichen, die "ecId" der API); die
-- Rohdaten- und metadata-Endpunkte erwarten als ecId die Gemeinschafts-ID,
-- nicht die RC-Nummer. Befund aus der Testinstanz am 24.8.2026, siehe
-- docs/eegfaktura-lokal.md. Null = RC-Nummer als ecId (bisheriges Verhalten).
alter table eegfaktura_source add column community_id text
    check (community_id = upper(community_id));

-- migrate:down

alter table eegfaktura_source drop column community_id;
