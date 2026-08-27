// Auswertung der importierten EEG-Faktura-Energiedaten fuer den Tab "Energie".
//
// Datenbasis: measurement_daily (Tagessummen je Zaehlpunkt und Kategorie, von der
// Pipeline aus den 15-Minuten-Werten in measurement gepflegt).
// Kategorien (meter_code.kind, Semantik wie ISCHLSTROM):
//   Verbrauchszaehlpunkte: total_consumption (Gesamtverbrauch), production_share
//     (Anteil gemeinschaftliche Erzeugung, zugeteilt), self_use (Eigendeckung,
//     davon tatsaechlich verbraucht)
//   Erzeugungszaehlpunkte: total_production (Gesamterzeugung), overshoot (Ueberschuss)
// Gemeinschaftlich: Eigendeckung = Erzeugung - Ueberschuss; Netzbezug = Verbrauch - Eigendeckung.
//
// Teillieferungen: EEG-Faktura liefert Tage manchmal mit Zeilen, aber fast nur
// Nullwerten. Ein Tag gilt als unvollstaendig, wenn weniger als MIN_MELDEANTEIL der
// Verbrauchszaehlpunkte einen Verbrauch > 0 gemeldet haben.
import { sql } from '$lib/server/db.js';

const TZ = 'Europe/Vienna';
export const MIN_MELDEANTEIL = 0.5;

/** @type {Record<string, {label: string, bucket: 'day' | 'month', n: number}>} */
export const ZEITRAEUME = {
	'30t': { label: '30 Tage', bucket: 'day', n: 30 },
	'90t': { label: '90 Tage', bucket: 'day', n: 90 },
	'12m': { label: '12 Monate', bucket: 'month', n: 12 },
	'24m': { label: '24 Monate', bucket: 'month', n: 24 }
};
export const DEFAULT_ZEITRAUM = '30t';

const KINDS = ['total_consumption', 'production_share', 'self_use', 'total_production', 'overshoot'];

/**
 * @typedef {{key: string, label: string, total_consumption: number, production_share: number, self_use: number,
 *   total_production: number, overshoot: number, days: number, incomplete_days: number}} Bucket
 */

/** Lokaler Tag (YYYY-MM-DD) bzw. Monat (YYYY-MM) als Anzeige. */
function bucketLabel(/** @type {string} */ key, /** @type {'day' | 'month'} */ bucket) {
	if (bucket === 'day') return `${Number(key.slice(8, 10))}.${Number(key.slice(5, 7))}.`;
	const monate = ['Jän', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
	return `${monate[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
}

/** Alle Bucket-Schluessel des Zeitraums (auch ohne Daten), aeltester zuerst. */
function bucketKeys(/** @type {string} */ startKey, /** @type {'day' | 'month'} */ bucket, /** @type {number} */ n) {
	const keys = [];
	const [y, m, d] = startKey.split('-').map(Number);
	for (let i = 0; i < n; i++) {
		const date = bucket === 'day' ? new Date(Date.UTC(y, m - 1, d + i)) : new Date(Date.UTC(y, m - 1 + i, 1));
		const iso = date.toISOString();
		keys.push(bucket === 'day' ? iso.slice(0, 10) : iso.slice(0, 7));
	}
	return keys;
}

/**
 * Energieauswertung eines Mandanten fuer einen Zeitraum.
 * @param {number} tenantId
 * @param {string} zeitraumKey Schluessel aus ZEITRAEUME
 */
export async function loadEnergie(tenantId, zeitraumKey) {
	const zeitraum = ZEITRAEUME[zeitraumKey] ?? ZEITRAEUME[DEFAULT_ZEITRAUM];
	const key = ZEITRAEUME[zeitraumKey] ? zeitraumKey : DEFAULT_ZEITRAUM;
	// Beginn des Zeitraums in lokaler Zeit: heute - (n-1) Tage bzw. Monatserster vor (n-1) Monaten
	const startLocal =
		zeitraum.bucket === 'day'
			? sql`date_trunc('day', now() at time zone ${TZ}) - make_interval(days => ${zeitraum.n - 1})`
			: sql`date_trunc('month', now() at time zone ${TZ}) - make_interval(months => ${zeitraum.n - 1})`;

	// Tagessummen je Kategorie plus Meldeanteil der Verbrauchszaehlpunkte
	// (aus dem Tagesaggregat measurement_daily, das die Pipeline pflegt)
	const dayRows = await sql`
		select d.day::text as tag, mc.kind,
			sum(d.kwh)::float as kwh,
			count(distinct d.measurement_point_id) filter (where d.nonzero_intervals > 0) as meldend
		from measurement_daily d
		join meter_code mc on mc.tenant_id = d.tenant_id and mc.id = d.meter_code_id
		where d.tenant_id = ${tenantId} and mc.kind is not null
			and d.day >= (${startLocal})::date
		group by 1, 2
		order by 1
	`;
	const [{ n: consumptionPoints }] = await sql`
		select count(*)::int as n from measurement_point where tenant_id = ${tenantId} and direction = 'consumption'
	`;
	const [{ start_key: startKey }] = await sql`
		select to_char(${startLocal}, ${zeitraum.bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'}) as start_key
	`;

	// Tage -> Buckets (Tag oder Monat), fehlende Buckets mit Nullen
	/** @type {Map<string, Bucket>} */
	const buckets = new Map();
	for (const k of bucketKeys(String(startKey), zeitraum.bucket, zeitraum.n)) {
		buckets.set(k, {
			key: k, label: bucketLabel(k, zeitraum.bucket),
			total_consumption: 0, production_share: 0, self_use: 0, total_production: 0, overshoot: 0,
			days: 0, incomplete_days: 0
		});
	}
	/** @type {Map<string, number>} Meldeanteil je Tag */
	const reporting = new Map();
	for (const r of dayRows) {
		const tag = String(r.tag);
		const b = buckets.get(zeitraum.bucket === 'day' ? tag : tag.slice(0, 7));
		if (!b) continue;
		const kind = String(r.kind);
		if (KINDS.includes(kind)) /** @type {any} */ (b)[kind] += Number(r.kwh);
		if (kind === 'total_consumption') {
			reporting.set(tag, consumptionPoints > 0 ? Number(r.meldend) / consumptionPoints : 0);
		}
	}
	for (const [tag, share] of reporting) {
		const b = buckets.get(zeitraum.bucket === 'day' ? tag : tag.slice(0, 7));
		if (!b) continue;
		b.days += 1;
		if (share < MIN_MELDEANTEIL) b.incomplete_days += 1;
	}
	const series = [...buckets.values()];

	// Datenbestand insgesamt (unabhaengig vom Zeitraum)
	const [coverage] = await sql`
		select min(measured_at) as first_at, max(measured_at) as last_at from measurement where tenant_id = ${tenantId}
	`;
	const [{ n: pointCount }] = await sql`select count(*)::int as n from measurement_point where tenant_id = ${tenantId}`;

	const sum = (/** @type {keyof Bucket} */ k) => series.reduce((a, b) => a + Number(b[k]), 0);
	const totals = {
		total_consumption: sum('total_consumption'),
		production_share: sum('production_share'),
		self_use: sum('self_use'),
		total_production: sum('total_production'),
		overshoot: sum('overshoot'),
		days: sum('days'),
		incomplete_days: sum('incomplete_days')
	};

	return {
		zeitraum: key,
		zeitraeume: Object.entries(ZEITRAEUME).map(([k, z]) => ({ key: k, label: z.label })),
		bucket: zeitraum.bucket,
		series,
		totals,
		coverage: {
			first_at: coverage?.first_at ? /** @type {Date} */ (coverage.first_at).toISOString() : null,
			last_at: coverage?.last_at ? /** @type {Date} */ (coverage.last_at).toISOString() : null,
			points: Number(pointCount),
			consumption_points: Number(consumptionPoints)
		}
	};
}
