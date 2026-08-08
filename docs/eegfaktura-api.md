# EEG-Faktura API: Erkenntnisse und Importer-Plan

Stand 8.8.2026. Quellen: eegfaktura-docs (mkdocs, Spiegel des Gitbooks), Quellcode von eegfaktura-backend, eegfaktura-energystore und eegfaktura-docker-compose (github.com/eegfaktura), sowie das nie fertiggestellte Probe-Notebook `notebooks/eegfaktura/API.ipynb` im ISCHLSTROM-Repo (12/2025).

## 1. Was die API bietet

Die SaaS-Instanz (https://eegfaktura.at) routet per Reverse-Proxy:

| Pfadprefix | Dienst | Für uns relevant |
|---|---|---|
| `/api/*` | backend (Go, Stammdaten) | `GET /api/master/masterdata` |
| `/energystore/*` | energystore (Go, Energiedaten) | `POST /energystore/query/rawdata`, `POST /energystore/query/{ecid}/metadata` |

Genau diese drei Endpunkte sind für Maschinenzugriff gedacht (Middleware `ProtectApi`); alles andere verlangt Browser-Login-Tokens.

### Authentifizierung, zwei Wege

1. **v1-Weg laut Quellcode (`ProtectApi`)**: `Authorization: Basic base64(user:passwort)` mit normalen Portal-Zugangsdaten plus Header `X-Tenant: <RC-Nummer>`. Der Server tauscht die Credentials serverseitig per Password Grant gegen seinen Keycloak (Client `at.ourproject.vfeeg.api`); der Aufrufer sieht nie ein Token. Der Tenant-Header muss im `tenant`-Claim des Benutzers stehen (Vergleich case-insensitiv, RC-Nummer).
2. **Dokumentierter SaaS-Weg (Gitbook)**: eigener, per Ticket beim VFEEG-Team registrierter Keycloak-Client; Token per `client_credentials` vom Keycloak (login.eegfaktura.at, Realm `EEGFaktura`; Client-ID/Secret im Authorization-Header, nicht im Body), ca. 5 Minuten gültig, danach Bearer-Aufrufe.

Beide Wege münden in denselben Endpunkten. Welcher auf der SaaS-Instanz tatsächlich freigeschaltet ist, entscheidet deren Keycloak-Konfiguration: der Basic-Weg setzt voraus, dass deren `api`-Client Direct Access Grants erlaubt; der Token-Weg setzt die Client-Registrierung per Ticket voraus. Unsere Probe vom 8.8. gegen den SPA-Client `at.ourproject.vfeeg.app` sagt dazu nichts aus, der `api`-Client ist ein anderer. Der Importer bekommt deshalb eine Auth-Abstraktion mit beiden Strategien je Mandant.

### Rohdaten-Endpunkt

`POST /energystore/query/rawdata`, Header `X-Tenant`, Body:

```json
{
  "ecId": "RC...",
  "start": 1735686000000,
  "end":   1738364399999,
  "cps": [{"meteringPoint": "AT0030000..."}],
  "format": "csv"
}
```

- `start`/`end` sind **Unix-Millisekunden** (Server: `time.UnixMilli`). Das ISCHLSTROM-Notebook schickte Sekunden und fragte damit effektiv Januar 1970 ab; das erklärt die ergebnislose Probe.
- `cps` leer oder weggelassen: der Server löst selbst alle im Zeitraum aktiven Zählpunkte auf.
- `format` weglassen für JSON; `"csv"` liefert eine CSV-Matrix.

JSON-Antwort: Map Zählpunkt zu `{direction, data: [{ts, value: [..], qov: [..]}]}` mit `ts` in Millisekunden je Viertelstunde. Die `value`-Slots sind fix belegt:

| Richtung | Slot | OBIS | Bedeutung | Unser `kind` |
|---|---|---|---|---|
| CONSUMPTION | 0 | G.01 | Gesamtverbrauch lt. Messung | total_consumption |
| CONSUMPTION | 1 | G.02 | Anteil gemeinschaftliche Erzeugung | production_share |
| CONSUMPTION | 2 | G.03 | Eigendeckung gemeinschaftliche Erzeugung | self_use |
| GENERATION | 0 | G.01 | Gesamte gemeinschaftliche Erzeugung | total_production |
| GENERATION | 1 | P.01 | Überschusserzeugung | overshoot |

`qov` je Slot: 1 gemessen, 2 Ersatzwert, 3 geschätzt, 0 unbekannt. Identitäten zur Plausibilisierung: G.03 <= G.02, G.03 <= G.01, Anteil = Eigendeckung + Überschuss (über die Gemeinschaft summiert).

`POST /energystore/query/{ecid}/metadata` liefert `{periodBegin, periodEnd}` (Millisekunden), also den insgesamt verfügbaren Zeitraum. Billiger Endpunkt, ideal als Zugangs-Smoke-Test.

`GET /api/master/masterdata` liefert die Teilnehmerliste mit Zählpunkten (meteringPoint, direction, status, gridOperator, activeSince/inactiveSince, partFact usw.), Grundlage für den `measurement_point`-Abgleich.

### Fallstricke

- **Millisekunden**, siehe oben.
- energystore dekodiert Basic-Auth mit **URL-safe Base64**. Python `requests` kodiert standard. Unterschiedlich sind nur `+` und `/`; enthält das Standard-Base64 der Credentials eines dieser Zeichen, scheitert der Login mit 403 trotz korrekter Daten. Abhilfe: Header selbst mit `base64.urlsafe_b64encode` bauen.
- Der Handler schreibt den Tenant in **Großbuchstaben**; RC-Nummer so konfigurieren.
- v1 (Badger) liest für jede Anfrage die gesamte Range: **kleine Chunks** (Monat), sequenziell, mit Backoff. Nie parallel je Mandant. energystore-v2 (TimescaleDB, Pilot) ist wire-kompatibel, der Client bleibt gleich.
- Teillieferungen existieren weiterhin: Zeilen vorhanden, aber viele Punkte nur Nullen oder qov != 1. Ein Tag gilt erst ab Mindest-Meldeanteil als vertrauenswürdig (ISCHLSTROM: 85%).

## 2. Plan

### Phase A: Zugang klären (Martin, parallel zu B)

1. **Ticket an VFEEG**, kombiniert mit der SSO-Anfrage (`docs/drafts/eegfaktura-sso-anfrage.md`): einen API-Client (client_credentials, Service-Account mit `tenant`-Attribut = RC-Nummer) und einen OIDC-Login-Client anfragen. Dabei klären: läuft die SaaS auf energystore v1 oder v2, gibt es Rate-Limits, ist `/api/master/masterdata` extern erreichbar.
2. **Sofort testbar ohne Ticket**: Basic-Weg mit den ISCHLSTROM-Portal-Zugangsdaten gegen den metadata-Endpunkt (Millisekunden, X-Tenant in Großbuchstaben, URL-safe Base64). Funktioniert das, haben wir den Importpfad schon heute; das Ticket bleibt trotzdem sinnvoll (sauberer Service-Zugang statt persönlicher Zugangsdaten, 5-Minuten-Token statt Passwort im Klartext je Request).

### Phase B: Importer in `pipeline/` (baubar ohne echten Zugang)

Modul `stromkreis_pipeline/eegfaktura/`:

1. **Client** (`client.py`): httpx/requests-Wrapper mit Auth-Strategie je Mandant (`basic` | `client_credentials`). Token-Cache mit Ablauf, Erneuerung kurz vor den 5 Minuten, ein Retry bei 401. Methoden: `metadata(ecid)`, `rawdata(ecid, start, end, cps=None)`, `masterdata()`. Zeitparameter als aware datetime, Umrechnung in Millisekunden nur an der HTTP-Grenze.
2. **Normalisierung** (`normalize.py`): Slot-zu-`kind`-Mapping laut Tabelle oben, ts zu UTC-Intervallbeginn, kWh unverändert. Gleiches Zwischenformat wie der spätere Excel-Parser, damit beide Quellen denselben Ladepfad nutzen.
3. **Laden** (`load.py`): Upsert in `measurement` (COPY in Temp-Tabelle plus `INSERT ... ON CONFLICT DO UPDATE`, Muster aus dem ISCHLSTROM-Notebook). `meter_code` je Mandant sicherstellen. `measurement_point`-Abgleich aus masterdata (neue Punkte anlegen, Status/Richtung aktualisieren; keine Mitglieder-Logik, Onboarding bleibt out of scope).
4. **Sync-Strategie** (`sync.py`): je Mandant inkrementell ab letztem importierten ts minus Überlappungsfenster (14 Tage, weil Ersatzwerte nachträglich korrigiert werden können), in Monats-Chunks bis heute. Erstimport: `periodBegin` aus metadata als Startpunkt, chunked Backfill. Danach Tages-Vollständigkeit berechnen (Meldeanteil je Tag, Schwelle 85% wie ISCHLSTROM) und als Gate für Forecast/Dashboards bereitstellen.
5. **Konfiguration**: Nicht-Geheimes je Mandant in der DB (RC-Nummer, Basis-URL, Auth-Modus, aktiv ja/nein); Secrets nur in der Server-`.env` (`EEGFAKTURA_<TENANTSLUG>_USER/PASSWORD` bzw. `_CLIENT_ID/_CLIENT_SECRET`), Konvention wie bisher.
6. **Excel-Fallback**: Parser für den Energy-Report-Export (Port aus `notebooks/energyData/EEG Faktura Energy Report.ipynb`) auf dasselbe Zwischenformat. Dient als Backfill-Quelle, Validierungsreferenz und Notfallpfad, falls die API klemmt.

Offene Schemafrage: `qov` mitführen? Empfehlung: nullable `quality smallint` auf `measurement` (qov des jeweiligen Slots), Migration klein, ermöglicht das Meldeanteil-Gate direkt in SQL. Entscheidung vor Baubeginn von B3.

### Phase C: Verifikation und Betrieb

1. **ISCHLSTROM als Testmandant**: API-Import gegen einen bekannten Excel-Export diffen (gleicher Zeitraum, Werte je Punkt/Kategorie identisch bis auf Rundung), erst dann dem Import vertrauen.
2. Pipeline-Lauf je Mandant im täglichen Scheduler-Loop (ein Loop über alle Mandanten, Fehler je Mandant isoliert und geloggt, kein Abbruch des Gesamtlaufs).
3. `status.md` und `architektur.md` nachziehen, sobald der Importer steht.

## 3. Offene Fragen an VFEEG (fürs Ticket)

- Client-Registrierung für client_credentials: Prozess, benötigte Angaben, wie wird der Service-Account einem Tenant (RC-Nummer) zugeordnet?
- Ist der Basic-Weg (`ProtectApi`) auf der SaaS-Instanz aktiv und offiziell zulässig?
- energystore v1 oder v2 auf der SaaS? Rate-Limits oder Zeitfenster für größere Backfills?
- Ist `GET /api/master/masterdata` extern erreichbar oder nur intern?
