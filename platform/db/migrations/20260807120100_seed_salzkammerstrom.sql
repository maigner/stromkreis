-- migrate:up

-- Erster Mandant: Dummy-EEG "Salzkammerstrom" (Testdaten, Standort Bad Ischl)
insert into tenant (slug, name, latitude, longitude)
values ('salzkammerstrom', 'Salzkammerstrom', 47.7126, 13.6197);

-- migrate:down

delete from tenant where slug = 'salzkammerstrom';
