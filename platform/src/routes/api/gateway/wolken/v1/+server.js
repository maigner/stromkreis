import { json } from '@sveltejs/kit';
import { siteByToken, cloudNextSunshineWindow, cloudHoursToday } from '$lib/server/gateway-data.js';

/**
 * Bewoelkungsvorhersage fuer das Speichermanagement (api/cloud_forecast.js
 * im Gateway-Paket). Body: { "token": "<geheim>" } - der Anlagen-Token
 * bindet die Abfrage an den Mandanten (POST, damit der Token in keinem
 * Access-Log landet).
 *
 * Antwort: { wolken: { vorschau, datum, stunden } } - `vorschau` ist die
 * mittlere Bewoelkung des naechsten Mittagsfensters, `stunden` die
 * Stundenwerte des restlichen Tages fuer die dynamische Laderegelung.
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

	const vorschau = await cloudNextSunshineWindow(site.tenant_id);
	if (vorschau === null) {
		return json({ error: 'Für das nächste Sonnenfenster liegen keine Wetterdaten vor' }, { status: 404 });
	}
	const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' }).format(new Date());
	const stunden = await cloudHoursToday(site.tenant_id);
	return json({ wolken: { vorschau, datum: heute, stunden } });
}
