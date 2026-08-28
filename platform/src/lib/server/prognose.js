// Tab "Prognose": Verbrauchs- und Erzeugungsprognose der Gemeinschaft fuer
// die naechsten zwei Wochen, aus dem juengsten Prognoselauf der Pipeline
// (forecast_run/forecast_value, gerechnet in stromkreis_pipeline/forecast.py
// nach jedem EEGFaktura-Import und periodisch im Worker). Die Plattform
// liest nur; jeder Lauf ist versioniert und wird nie ueberschrieben.
import { sql } from '$lib/server/db.js';

const TZ = 'Europe/Vienna';
export const PROGNOSE_TAGE = 14;

/**
 * Juengster Prognoselauf eines Mandanten samt Stundenreihe (Diagramm) und
 * Tagessummen (Tabelle) fuer heute bis heute plus PROGNOSE_TAGE.
 * @param {number} tenantId
 */
export async function loadPrognose(tenantId) {
	const [run] = await sql`
		select id, created_at, model_version, data_until::text as data_until,
			horizon_start, horizon_end, training_intervals, parameters
		from forecast_run
		where tenant_id = ${tenantId}
		order by created_at desc
		limit 1
	`;
	if (!run) return { run: null, hours: [], days: [], weather: [] };
	const runId = Number(run.id);

	// Fenster jeweils: heute 00:00 lokal bis in PROGNOSE_TAGE Tagen; weiter
	// reicht das Open-Meteo-Wetter (16 Tage) ohnehin kaum
	const hours = await sql`
		select date_trunc('hour', v.time) as ts,
			sum(v.consumption_kwh)::float as consumption,
			sum(v.consumption_kwh_p10)::float as consumption_p10,
			sum(v.consumption_kwh_p90)::float as consumption_p90,
			sum(v.generation_kwh)::float as generation,
			sum(v.generation_kwh_p10)::float as generation_p10,
			sum(v.generation_kwh_p90)::float as generation_p90,
			sum(v.self_coverage_kwh)::float as self_coverage
		from forecast_value v
		where v.tenant_id = ${tenantId} and v.run_id = ${runId}
			and v.time >= (date_trunc('day', now() at time zone ${TZ})) at time zone ${TZ}
			and v.time < (date_trunc('day', now() at time zone ${TZ}) + make_interval(days => ${PROGNOSE_TAGE})) at time zone ${TZ}
		group by 1
		order by 1
	`;

	const days = await sql`
		select (v.time at time zone ${TZ})::date::text as tag,
			count(*)::int as intervals,
			sum(v.consumption_kwh)::float as consumption,
			sum(v.generation_kwh)::float as generation,
			sum(v.self_coverage_kwh)::float as self_coverage,
			sum(v.surplus_kwh)::float as surplus
		from forecast_value v
		where v.tenant_id = ${tenantId} and v.run_id = ${runId}
			and v.time >= (date_trunc('day', now() at time zone ${TZ})) at time zone ${TZ}
			and v.time < (date_trunc('day', now() at time zone ${TZ}) + make_interval(days => ${PROGNOSE_TAGE})) at time zone ${TZ}
		group by 1
		order by 1
	`;

	// Wetterentwicklung im selben Fenster (Stundenwerte aus dem Open-Meteo-
	// Import der Pipeline): Globalstrahlung treibt die PV-Erzeugung,
	// Temperatur und Regen geben den Rahmen
	const weather = await sql`
		select w.time,
			w.temperature_2m::float as temperature,
			coalesce(w.shortwave_radiation, 0)::float as radiation,
			w.cloud_cover::float as cloud_cover,
			w.rain::float as rain
		from weather w
		where w.tenant_id = ${tenantId}
			and w.time >= (date_trunc('day', now() at time zone ${TZ})) at time zone ${TZ}
			and w.time < (date_trunc('day', now() at time zone ${TZ}) + make_interval(days => ${PROGNOSE_TAGE})) at time zone ${TZ}
		order by w.time
	`;

	return {
		run: {
			id: runId,
			created_at: /** @type {Date} */ (run.created_at).toISOString(),
			model_version: String(run.model_version),
			data_until: String(run.data_until),
			horizon_end: /** @type {Date} */ (run.horizon_end).toISOString(),
			training_intervals: Number(run.training_intervals)
		},
		hours: hours.map((h) => ({
			ts: /** @type {Date} */ (h.ts).toISOString(),
			consumption: Number(h.consumption),
			consumption_p10: h.consumption_p10 == null ? null : Number(h.consumption_p10),
			consumption_p90: h.consumption_p90 == null ? null : Number(h.consumption_p90),
			generation: Number(h.generation),
			generation_p10: h.generation_p10 == null ? null : Number(h.generation_p10),
			generation_p90: h.generation_p90 == null ? null : Number(h.generation_p90),
			self_coverage: Number(h.self_coverage)
		})),
		weather: weather.map((w) => ({
			ts: /** @type {Date} */ (w.time).toISOString(),
			temperature: Number(w.temperature),
			radiation: Number(w.radiation),
			cloud_cover: Number(w.cloud_cover),
			rain: Number(w.rain)
		})),
		// Randtage am Ende des Wetterhorizonts koennen unvollstaendig sein; solche
		// Tage fallen aus den Tagesmitteln (sonst wirken die Durchschnitte zu klein)
		days: days
			.filter((d) => Number(d.intervals) >= 90)
			.map((d) => ({
				tag: String(d.tag),
				consumption: Number(d.consumption),
				generation: Number(d.generation),
				self_coverage: Number(d.self_coverage),
				surplus: Number(d.surplus),
				coverage_pct: Number(d.consumption) > 0 ? (100 * Number(d.self_coverage)) / Number(d.consumption) : null
			}))
	};
}
