# Stromkreis Platform

SvelteKit 5 + Tailwind 4 (JS mit jsdoc, adapter-node): mandantenfähige Weboberfläche und IBM-API.

## Entwicklung

```sh
npm install
npm run dev
```

`npm run build` erzeugt den Produktions-Build, `npm run preview` zeigt ihn lokal, `npm run check` prüft mit svelte-check.

## Datenbank

Die Schema-Autorität liegt hier bei der Plattform. Migrationen sind reines SQL ([dbmate](https://github.com/amacneil/dbmate)) unter `db/migrations/`; das generierte `db/schema.sql` ist eingecheckt und dient der Pipeline als dokumentierter Vertrag.

```sh
cp .env.example .env        # DATABASE_URL anpassen
npm run db:migrate          # Migrationen anwenden (legt die DB bei Bedarf an)
npm run db:status           # Stand anzeigen
npm run db:rollback         # letzte Migration zurücknehmen
npm run db:new -- name      # neue Migration anlegen
```

Hinweis: Zum automatischen Aktualisieren von `db/schema.sql` braucht dbmate lokal `pg_dump` (Paket `postgresql-client`). Ohne Client-Tools laufen die Migrationen trotzdem, nur der Dump wird nicht erneuert.

Konvention: Jede Fachtabelle trägt `tenant_id not null references tenant (id)`. Referenzen zwischen Fachtabellen verwenden zusammengesetzte Fremdschlüssel über `(tenant_id, id)`, damit mandantenübergreifende Verweise schon auf Datenbankebene unmöglich sind (siehe `measurement_point.member_id`).
