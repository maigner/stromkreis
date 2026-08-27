// Tab "Energie": Speicherpotential aus PV-Ueberschuss.
//
// Die reinen Energiezahlen (Verbrauch, Erzeugung, Eigendeckung) sehen die
// Betreiber schon in EEG-Faktura; hier geht es um die Frage, die EEG-Faktura
// nicht beantwortet: wie viel Ueberschuss (overshoot: gemeinschaftliche
// Erzeugung, die nicht direkt verbraucht wurde und ins Netz ging) hatte die
// EEG im Schnitt pro Tag in den letzten TAGE Tagen? Das ist das Potential
// fuer einen Batteriespeicher. Nutzbar ist davon je Tag hoechstens der
// Netzbezug (Verbrauch - Eigendeckung): mehr kann ein Speicher nicht
// ersetzen (Wirkungsgradverluste hier nicht eingerechnet).
//
// Datenbasis: Tagesaggregat measurement_daily (von der Pipeline gepflegt).
// Teillieferungen: Tage, an denen weniger als MIN_MELDEANTEIL der
// Verbrauchszaehlpunkte einen Verbrauch > 0 gemeldet haben, gelten als
// unvollstaendig und bleiben aus den Durchschnitten draussen (EEG-Faktura
// liefert solche Tage spaeter nach).
import { sql } from '$lib/server/db.js';

const TZ = 'Europe/Vienna';
export const MIN_MELDEANTEIL = 0.5;
export const TAGE = 30;

/**
 * @typedef {{key: string, label: string, overshoot: number, netzbezug: number, nutzbar: number,
 *   has_data: boolean, complete: boolean}} Tag
 */

/**
 * Speicherpotential eines Mandanten aus den letzten TAGE Tagen.
 * @param {number} tenantId
 */
export async function loadEnergie(tenantId) {
	// Tagessummen (lokale Tage, heute eingeschlossen) samt Meldeanteil
	const rows = await sql`
		select d.day::text as tag,
			coalesce(sum(d.kwh) filter (where mc.kind = 'overshoot'), 0)::float as overshoot,
			coalesce(sum(d.kwh) filter (where mc.kind = 'total_consumption'), 0)::float as consumption,
			coalesce(sum(d.kwh) filter (where mc.kind = 'self_use'), 0)::float as self_use,
			count(distinct d.measurement_point_id) filter (where mc.kind = 'total_consumption' and d.nonzero_intervals > 0)::int as meldend
		from measurement_daily d
		join meter_code mc on mc.tenant_id = d.tenant_id and mc.id = d.meter_code_id
		where d.tenant_id = ${tenantId}
			and d.day >= (date_trunc('day', now() at time zone ${TZ}) - make_interval(days => ${TAGE - 1}))::date
		group by 1
		order by 1
	`;
	const [{ n: consumptionPoints }] = await sql`
		select count(*)::int as n from measurement_point where tenant_id = ${tenantId} and direction = 'consumption'
	`;
	const [{ start_key: startKey }] = await sql`
		select to_char(date_trunc('day', now() at time zone ${TZ}) - make_interval(days => ${TAGE - 1}), 'YYYY-MM-DD') as start_key
	`;

	const byDay = new Map(rows.map((r) => [String(r.tag), r]));
	const [y, m, d] = String(startKey).split('-').map(Number);
	/** @type {Tag[]} */
	const days = [];
	for (let i = 0; i < TAGE; i++) {
		const key = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
		const r = byDay.get(key);
		const overshoot = r ? Number(r.overshoot) : 0;
		const netzbezug = r ? Math.max(0, Number(r.consumption) - Number(r.self_use)) : 0;
		days.push({
			key,
			label: `${Number(key.slice(8, 10))}.${Number(key.slice(5, 7))}.`,
			overshoot,
			netzbezug,
			nutzbar: Math.min(overshoot, netzbezug),
			has_data: r != null,
			complete: r != null && consumptionPoints > 0 && Number(r.meldend) / consumptionPoints >= MIN_MELDEANTEIL
		});
	}

	// Durchschnitte nur ueber vollstaendige Tage
	const complete = days.filter((t) => t.complete);
	const avg = (/** @type {(t: Tag) => number} */ f) =>
		complete.length ? complete.reduce((a, t) => a + f(t), 0) / complete.length : 0;
	const stats = {
		complete_days: complete.length,
		incomplete_days: days.filter((t) => t.has_data && !t.complete).length,
		avg_overshoot: avg((t) => t.overshoot),
		avg_netzbezug: avg((t) => t.netzbezug),
		avg_nutzbar: avg((t) => t.nutzbar)
	};

	// Datenbestand insgesamt (unabhaengig vom Zeitraum)
	const [coverage] = await sql`
		select min(measured_at) as first_at, max(measured_at) as last_at from measurement where tenant_id = ${tenantId}
	`;
	const [{ n: pointCount }] = await sql`select count(*)::int as n from measurement_point where tenant_id = ${tenantId}`;

	return {
		days,
		stats,
		coverage: {
			first_at: coverage?.first_at ? /** @type {Date} */ (coverage.first_at).toISOString() : null,
			last_at: coverage?.last_at ? /** @type {Date} */ (coverage.last_at).toISOString() : null,
			points: Number(pointCount),
			consumption_points: Number(consumptionPoints)
		}
	};
}
