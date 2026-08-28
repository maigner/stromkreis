import { json } from '@sveltejs/kit';
import { siteByToken, weeklyCrossover } from '$lib/server/gateway-data.js';

/**
 * Durchschnittliche Crossover-Zeiten der Gemeinschaft (api/crossover.js im
 * Gateway-Paket): wann deckt die Erzeugung morgens erstmals den Verbrauch,
 * wann kippt es abends zurueck. Body: { "token": "<geheim>" }.
 *
 * Antwort: { crossover: { week_number, avg_morning_crossover,
 * avg_evening_crossover, days_averaged } }.
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

	const crossover = await weeklyCrossover(site.tenant_id);
	if (!crossover) {
		return json({ error: 'Es liegen noch keine vollständigen Messtage vor' }, { status: 404 });
	}
	return json({ crossover });
}
