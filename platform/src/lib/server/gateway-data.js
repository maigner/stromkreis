// Datenendpunkte fuer die Gateways (Speichermanagement), portiert aus dem
// ISCHLSTROM-Repo (website/src/lib/server/db/energy/forecast.ts,
// weather/forecast.ts, overview.ts) und mandantenfaehig gemacht: jede
// Abfrage ist ueber die Anlage (Anlagen-Token) an einen Mandanten gebunden.
//
// Die Prognose selbst rechnet die Pipeline (pipeline/stromkreis_pipeline/
// forecast.py) in forecast_run/forecast_value; hier wird nur gelesen.
import { createHash } from 'node:crypto';
import { sql } from './db.js';

// --- Anlage ueber den Token ---------------------------------------------------

/**
 * Anlage zu einem Anlagen-Token (nur der Hash ist gespeichert).
 * @param {string} token
 * @returns {Promise<{ id: number, tenant_id: number, name: string, inverter_profile: string, status: Record<string, any> } | null>}
 */
export async function siteByToken(token) {
	if (typeof token !== 'string' || !token || token.length > 200) return null;
	const hash = createHash('sha256').update(token.trim()).digest('hex');
	const [site] = await sql`
		select id, tenant_id, name, inverter_profile, status
		from battery_site where token_hash = ${hash}`;
	return /** @type {any} */ (site) ?? null;
}

// --- Bewoelkung (weather, Open-Meteo-Import der Pipeline) --------------------

/**
 * Mittlere Bewoelkung im naechsten Mittagsfenster (10:00 bis 14:00
 * Europe/Vienna, heute vor 12:00 Lokalzeit, sonst morgen). Null ohne Daten:
 * 0 wuerde vom Gateway als "0% Wolken" (voller Sonnenschein) gelesen und
 * die aggressivste Steuerung ausloesen.
 * @param {number} tenantId
 */
export async function cloudNextSunshineWindow(tenantId) {
	const [row] = await sql`
		with fenster as (
			select case when (now() at time zone 'Europe/Vienna')::time < time '12:00'
				then (now() at time zone 'Europe/Vienna')::date
				else (now() at time zone 'Europe/Vienna')::date + 1 end as tag
		)
		select avg(w.cloud_cover)::float as vorschau, count(*)::int as n
		from weather w, fenster f
		where w.tenant_id = ${tenantId}
			and w.time >= (f.tag + time '10:00') at time zone 'Europe/Vienna'
			and w.time < (f.tag + time '14:00') at time zone 'Europe/Vienna'`;
	if (!row || !row.n || row.vorschau == null) return null;
	return Number(row.vorschau);
}

/**
 * Stuendliche Bewoelkung vom Beginn der laufenden Stunde bis Mitternacht
 * (Europe/Vienna), fuer die dynamische Laderegelung am Gateway.
 * @param {number} tenantId
 * @returns {Promise<{ zeit: string, wolken: number }[]>}
 */
export async function cloudHoursToday(tenantId) {
	const rows = await sql`
		select to_char(time at time zone 'Europe/Vienna', 'HH24:MI') as zeit,
			cloud_cover as wolken
		from weather
		where tenant_id = ${tenantId}
			and time >= date_trunc('hour', now())
			and (time at time zone 'Europe/Vienna')::date = (now() at time zone 'Europe/Vienna')::date
		order by time`;
	return rows
		.map((r) => ({ zeit: String(r.zeit), wolken: Number(r.wolken) }))
		.filter((s) => /^\d{2}:\d{2}$/.test(s.zeit) && Number.isFinite(s.wolken) && s.wolken >= 0 && s.wolken <= 100);
}

// --- Crossover (Messdaten) ---------------------------------------------------

/**
 * Durchschnittliche Crossover-Zeiten (Erzeugung >= Verbrauch der
 * Gemeinschaft) der letzten vollstaendig gelieferten Tage: Vormittags-Start
 * und Abend-Ende, gemittelt ueber bis zu 7 Tage der letzten zwei Wochen.
 * Anders als bei ISCHLSTROM (Kalenderwochen-View) zaehlen die juengsten
 * vollstaendigen Tage - das vertraegt sich besser mit Teillieferungen.
 * @param {number} tenantId
 */
export async function weeklyCrossover(tenantId) {
	const [row] = await sql`
		with slots as (
			select (m.measured_at at time zone 'Europe/Vienna')::date as tag,
				m.measured_at at time zone 'Europe/Vienna' as ts_local,
				sum(m.value) filter (where mc.kind = 'total_production') as gen,
				sum(m.value) filter (where mc.kind = 'total_consumption') as cons
			from measurement m
			join meter_code mc on mc.tenant_id = m.tenant_id and mc.id = m.meter_code_id
			where m.tenant_id = ${tenantId}
				and mc.kind in ('total_production', 'total_consumption')
				and m.measured_at >= (now() at time zone 'Europe/Vienna')::date - 14
			group by 1, 2
		),
		tage as (
			select tag,
				min(ts_local::time) filter (where gen >= cons and cons > 0
					and extract(hour from ts_local) between 4 and 12) as morgens,
				max(ts_local::time) filter (where gen >= cons and cons > 0
					and extract(hour from ts_local) >= 12) as abends
			from slots
			group by tag
			having count(*) = 96 and sum(gen) > 0
		),
		letzte as (
			select * from tage
			where morgens is not null and abends is not null
			order by tag desc limit 7
		)
		select count(*)::int as days_averaged,
			to_char(time '00:00' + avg(morgens - time '00:00'), 'HH24:MI:SS') as avg_morning_crossover,
			to_char(time '00:00' + avg(abends - time '00:00'), 'HH24:MI:SS') as avg_evening_crossover,
			extract(week from (now() at time zone 'Europe/Vienna')::date)::int as week_number
		from letzte`;
	if (!row || !row.days_averaged) return null;
	return {
		week_number: row.week_number,
		avg_morning_crossover: row.avg_morning_crossover,
		avg_evening_crossover: row.avg_evening_crossover,
		days_averaged: row.days_averaged
	};
}

// --- Prognose (forecast_run / forecast_value) --------------------------------

/** Neuester Prognoselauf des Mandanten (Hindcasts zaehlen nicht).
 * @param {number} tenantId */
export async function latestForecastRun(tenantId) {
	const [run] = await sql`
		select id, created_at, model_version, data_until, horizon_start, horizon_end
		from forecast_run
		where tenant_id = ${tenantId} and model_version not like '%hindcast%'
		order by created_at desc limit 1`;
	return run ?? null;
}

/**
 * Ladesperre-Fenster der Gemeinschaft fuer heute: vom ersten nennenswerten
 * Sonnenschein (Erzeugung ueber 5% des Tagesmaximums) bis in die
 * Mittagsspitze. Das Ende ist der spaetere von Vormittags-Crossover und dem
 * ersten Slot mit Ueberschuss >= 75% des Tagesmaximums, nie spaeter als der
 * Spitzen-Slot und nie nach 14:00. `ende` null = heute keine Sperre.
 * @param {number} tenantId @param {number} runId
 */
export async function todayChargeWindow(tenantId, runId) {
	const [row] = await sql`
		with slots as (
			select time at time zone 'Europe/Vienna' as ts_local,
				generation_kwh, consumption_kwh,
				generation_kwh - consumption_kwh as surplus_kwh
			from forecast_value
			where tenant_id = ${tenantId} and run_id = ${runId}
				and (time at time zone 'Europe/Vienna')::date = (now() at time zone 'Europe/Vienna')::date
		),
		peak as (
			select max(generation_kwh) as max_gen, max(surplus_kwh) as max_surplus from slots
		),
		crossover as (
			select min(ts_local) as t from slots
			where generation_kwh >= consumption_kwh and extract(hour from ts_local) >= 3
		),
		extended as (
			select case when (select t from crossover) is null then null
				else least(
					greatest(
						(select t from crossover),
						(select min(ts_local) from slots, peak
							where peak.max_surplus > 0
								and surplus_kwh >= 0.75 * peak.max_surplus
								and extract(hour from ts_local) >= 3)
					),
					(select min(ts_local) from slots, peak
						where peak.max_surplus > 0 and surplus_kwh = peak.max_surplus),
					(now() at time zone 'Europe/Vienna')::date + time '14:00'
				) end as t
		)
		select count(*)::int as intervals,
			to_char((now() at time zone 'Europe/Vienna')::date, 'YYYY-MM-DD') as datum,
			to_char(min(ts_local) filter (
				where generation_kwh > 0.05 * (select max_gen from peak)
			), 'HH24:MI') as start,
			to_char((select t from extended), 'HH24:MI') as ende
		from slots`;
	if (!row || !row.intervals) return null;
	return { datum: row.datum, start: row.start, ende: row.ende };
}

// Parameter des individualisierten Sperr-Endes - bewusst am Server, damit
// Tuning kein Paket-Update auf den Anlagen braucht (Werte wie ISCHLSTROM).
const CHARGE_FRACTION = 0.95; // nachgeladen wird, was bis 95% der Kapazitaet fehlt
const SAFETY_FACTOR = 1.3; // Aufschlag fuer Prognosefehler und Dunst
const FULL_BUFFER_MIN = 60; // so viele Minuten vor dem Abend-Crossover voll
const LATEST_END_MIN = 14 * 60; // spaeter endet keine Sperre
const DISCHARGE_MIN_DEFICIT_SHARE = 0.25; // Mindest-Defizit als Verbrauchsanteil
const DISCHARGE_FLEET_FACTOR = 2; // ... und als Vielfaches der Flotten-Entladeleistung

/** @param {number} m */
const fmtMinutes = (m) => {
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return `${h < 10 ? '0' : ''}${h}:${mm < 10 ? '0' : ''}${mm}`;
};

/** Bester 15-Minuten-Slot des ganzen Laufs (Referenz der Normierung).
 * @param {number} tenantId @param {number} runId */
async function runMaxGeneration(tenantId, runId) {
	const [row] = await sql`
		select max(generation_kwh)::float as max_gen
		from forecast_value where tenant_id = ${tenantId} and run_id = ${runId}`;
	const maxGen = Number(row?.max_gen);
	return Number.isFinite(maxGen) && maxGen > 0 ? maxGen : null;
}

/** Die 15-Minuten-Slots des heutigen Tages als Minute des Tages.
 * @param {number} tenantId @param {number} runId */
async function todaySlots(tenantId, runId) {
	const rows = await sql`
		select (extract(hour from time at time zone 'Europe/Vienna') * 60
			+ extract(minute from time at time zone 'Europe/Vienna'))::int as minute_of_day,
			generation_kwh, consumption_kwh
		from forecast_value
		where tenant_id = ${tenantId} and run_id = ${runId}
			and (time at time zone 'Europe/Vienna')::date = (now() at time zone 'Europe/Vienna')::date
		order by 1`;
	return rows.map((r) => ({
		minute: Number(r.minute_of_day),
		gen: Number(r.generation_kwh),
		cons: Number(r.consumption_kwh)
	}));
}

/**
 * Individualisiertes Sperr-Ende ("HH:MM") fuer eine Anlage: rueckwaerts von
 * der Abend-Deadline wird das normierte Erzeugungsprofil des Prognosetags,
 * skaliert mit der gemeldeten Ladeleistung, aufintegriert, bis die fehlende
 * Energie gedeckt ist. Null: keine Sperre noetig oder nicht berechenbar.
 * @param {number} tenantId @param {number} runId
 * @param {number} capacityKwh @param {number} chargeRateKw @param {number | null} socPct
 */
export async function individualChargeWindowEnd(tenantId, runId, capacityKwh, chargeRateKw, socPct = null) {
	const slots = await todaySlots(tenantId, runId);
	if (slots.length === 0) return null;
	const maxGen = await runMaxGeneration(tenantId, runId);
	if (maxGen === null) return null;

	let crossoverEnd = null;
	for (const s of slots) {
		if (s.gen >= s.cons) crossoverEnd = s.minute + 15;
	}
	if (crossoverEnd === null) return null;

	const deadline = crossoverEnd - FULL_BUFFER_MIN;
	const soc = socPct !== null && Number.isFinite(socPct) ? Math.min(100, Math.max(0, socPct)) : 0;
	const neededKwh = capacityKwh * Math.max(0, CHARGE_FRACTION - soc / 100) * SAFETY_FACTOR;

	let cumKwh = 0;
	for (let i = slots.length - 1; i >= 0; i--) {
		const s = slots[i];
		if (s.minute + 15 > deadline) continue;
		cumKwh += chargeRateKw * (s.gen / maxGen) * 0.25;
		if (cumKwh >= neededKwh) {
			return fmtMinutes(Math.min(s.minute, LATEST_END_MIN));
		}
	}
	return null;
}

/**
 * Stuendliche Ladefaktoren (0..1) des heutigen Tages samt Abend-Deadline
 * fuer die dynamische Laderegelung am Gateway. Null, wenn der Prognosetag
 * keine Berechnung hergibt.
 * @param {number} tenantId @param {number} runId
 */
export async function chargeFactorsToday(tenantId, runId) {
	const slots = await todaySlots(tenantId, runId);
	if (slots.length === 0) return null;
	const maxGen = await runMaxGeneration(tenantId, runId);
	if (maxGen === null) return null;

	let crossoverEnd = null;
	for (const s of slots) {
		if (s.gen >= s.cons) crossoverEnd = s.minute + 15;
	}
	if (crossoverEnd === null) return null;
	const deadline = crossoverEnd - FULL_BUFFER_MIN;

	const nowMinute = (() => {
		const parts = new Intl.DateTimeFormat('de-AT', {
			timeZone: 'Europe/Vienna',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).formatToParts(new Date());
		const h = Number(parts.find((p) => p.type === 'hour')?.value);
		const m = Number(parts.find((p) => p.type === 'minute')?.value);
		return h * 60 + m;
	})();

	/** @type {Map<number, { sum: number, n: number }>} */
	const perHour = new Map();
	for (const s of slots) {
		const hour = Math.floor(s.minute / 60);
		if ((hour + 1) * 60 <= Math.floor(nowMinute / 60) * 60) continue; // Stunde vorbei
		if (hour * 60 >= deadline) continue; // nach der Deadline
		const acc = perHour.get(hour) ?? { sum: 0, n: 0 };
		acc.sum += Math.min(Math.max(s.gen / maxGen, 0), 1);
		acc.n += 1;
		perHour.set(hour, acc);
	}
	if (perHour.size === 0) return null;

	const stunden = [...perHour.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([hour, acc]) => ({
			zeit: fmtMinutes(hour * 60),
			faktor: Math.round((acc.sum / acc.n) * 1000) / 1000
		}));

	return { deadline: fmtMinutes(deadline), stunden };
}

/**
 * Entladestart der heutigen Nacht ("HH:MM"): der erste Slot nach dem
 * Abend-Crossover, in dem das Defizit der Gemeinschaft gross genug ist, um
 * die Nachteinspeisung der Batterien sicher aufzunehmen. Null: das Gateway
 * faellt auf Crossover plus festen Abstand zurueck.
 * @param {number} tenantId @param {number} runId @param {number} fleetDischargeKw
 */
export async function todayDischargeStart(tenantId, runId, fleetDischargeKw) {
	const slots = await todaySlots(tenantId, runId);
	if (slots.length === 0) return null;

	let crossoverEnd = null;
	for (const s of slots) {
		if (s.minute >= 12 * 60 && s.gen >= s.cons) crossoverEnd = s.minute + 15;
	}
	if (crossoverEnd === null) return null;

	for (const s of slots) {
		if (s.minute < crossoverEnd) continue;
		const deficitKw = (s.cons - s.gen) * 4;
		const neededKw = Math.max(
			s.cons * 4 * DISCHARGE_MIN_DEFICIT_SHARE,
			fleetDischargeKw * DISCHARGE_FLEET_FACTOR
		);
		if (deficitKw >= neededKw) return fmtMinutes(s.minute);
	}
	return null;
}

/**
 * Summe der maximalen Entladeleistungen aller aktiven Anlagen des Mandanten
 * (zuletzt innerhalb einer Stunde gemeldet, Hauptschalter und Entladung an),
 * in kW. Anlagen ohne gemeldeten Wert zaehlen mit 3 kW.
 * @param {number} tenantId
 */
export async function fleetDischargeKw(tenantId) {
	const [row] = await sql`
		select coalesce(sum(case when jsonb_typeof(status->'max_entladeleistung_w') = 'number'
			then (status->>'max_entladeleistung_w')::float else 3000 end), 0) / 1000 as kw
		from battery_site
		where tenant_id = ${tenantId}
			and last_seen_at > now() - interval '1 hour'
			and status->>'hauptschalter' = 'ON'
			and coalesce(status->>'entladung_aktiv', 'ON') = 'ON'`;
	const kw = Number(row?.kw);
	return Number.isFinite(kw) ? kw : 0;
}
