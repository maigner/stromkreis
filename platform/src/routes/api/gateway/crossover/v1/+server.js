import { json } from '@sveltejs/kit';
import { siteByToken, weeklyCrossover } from '$lib/server/gateway-data.js';

/**
 * Durchschnittliche Crossover-Zeiten der Gemeinschaft (api/crossover.js im
 * Gateway-Paket): wann deckt die Erzeugung morgens erstmals den Verbrauch,
 * wann kippt es abends zurueck. Body: { "token": "<geheim>" }.
 *
 * Antwort: { crossover: { week_number, avg_morning_crossover,
 * avg_evening_crossover, days_averaged } }. Gab es vollstaendige Messtage,
 * aber keinen Crossover (Winter: die Gemeinschaft kommt nie ins Plus), kommt
 * 404 mit `crossover: null` - das Gateway loescht daran seine Werte und
 * entlaedt nicht mehr, statt mit den Zeiten der letzten Woche mit Daten
 * weiterzulaufen. Fehlen die Messtage ganz (Datenluecke) oder wird der Token
 * abgelehnt, traegt die Antwort kein `crossover`-Feld: das Gateway laesst
 * seine Werte stehen und verwirft sie nach 14 Tagen ohne Abruf selbst.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const site = await siteByToken(body?.token);
	if (!site) return json({ error: 'Unbekannter Token.' }, { status: 401 });

	const { crossover, complete_days } = await weeklyCrossover(site.tenant_id);
	if (!crossover) {
		if (complete_days > 0) {
			return json(
				{ error: 'In den letzten vollständigen Messtagen gibt es keine Crossover-Zeiten', crossover: null },
				{ status: 404 }
			);
		}
		return json({ error: 'Es liegen noch keine vollständigen Messtage vor' }, { status: 404 });
	}
	return json({ crossover });
}
