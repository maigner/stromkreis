import { json } from '@sveltejs/kit';
import { consumeProvisionCode } from '$lib/server/gateway-provision.js';
import { clientKey, createRateLimiter } from '$lib/server/rate-limit.js';

// Erstkontakt des Gateways: POST {code} liefert die Konfiguration (ibm.conf-Schluessel)
// samt frischem Anlagen-Token. Bewusst POST, damit der Code nicht in Zugriffslogs landet.
//
// Bremse gegen Durchprobieren (Befund S3): gezaehlt werden nur Fehlversuche
// (unbekannter oder abgelaufener Code), damit ein Gateway, das nach einem
// Neustart seinen gueltigen Code erneut einloest, nie ausgebremst wird.
// Je Adresse 10 Fehlversuche in 10 Minuten, dazu ein gemeinsames Kontingent
// von 100 fuer alle Adressen (gegen verteiltes Raten); danach 429 fuer alle
// Anfragen aus dieser Quelle bzw. fuer alle, bis das Fenster frei ist.
const PER_IP = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
const GLOBAL = createRateLimiter({ max: 100, windowMs: 10 * 60 * 1000 });
const GLOBAL_KEY = '*';

export async function POST(event) {
	const ip = clientKey(event);
	if (PER_IP.limited(ip) || GLOBAL.limited(GLOBAL_KEY)) {
		return json({ error: 'Zu viele Fehlversuche, bitte spaeter erneut versuchen' }, { status: 429, headers: { 'retry-after': '600' } });
	}
	let body;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const code = typeof body?.code === 'string' ? body.code : '';
	const result = await consumeProvisionCode(code);
	if (!result) {
		PER_IP.hit(ip);
		GLOBAL.hit(GLOBAL_KEY);
		console.log(`provision: ungueltiger oder abgelaufener Einrichtungscode von ${ip}`);
		return json({ error: 'Einrichtungscode ungueltig oder abgelaufen' }, { status: 404 });
	}
	return json({ config: result.config, anlage: { id: result.site.id, name: result.site.name, eeg: result.site.tenant_name } });
}
