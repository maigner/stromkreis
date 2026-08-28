import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { sql } from '$lib/server/db.js';

// Groessenlimit des data-JSON; schuetzt die Tabelle vor aufgeblasenen Payloads.
const MAX_STATUS_DATA_BYTES = 16 * 1024;

/**
 * Status-Push der Gateways (api/status_push.js im Gateway-Paket).
 *
 * Body: { "token": "<geheim>", "anlage": "<name>", "data": { ... } }
 *
 * Die Gateways melden minuetlich: schlanke Meldungen mit den Momentanwerten
 * und alle 5 Minuten eine volle Meldung mit Log, Versionen, apt-Updates und
 * Systemzustand (erkennbar am Feld `versions`). Volle Meldungen ersetzen
 * den gespeicherten Status komplett, schlanke werden hineingemischt - so
 * bleiben die zuletzt voll gemeldeten Felder in der Anlagenansicht sichtbar.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const token = typeof body?.token === 'string' ? body.token.trim() : '';
	const anlage = typeof body?.anlage === 'string' ? body.anlage.trim() : '';
	const data = body?.data;
	if (!token || token.length > 200) {
		return json({ error: "Feld 'token' fehlt oder ist ungültig" }, { status: 400 });
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return json({ error: "Feld 'data' fehlt oder ist kein Objekt" }, { status: 400 });
	}
	if (JSON.stringify(data).length > MAX_STATUS_DATA_BYTES) {
		return json({ error: "Feld 'data' ist zu groß" }, { status: 413 });
	}

	// Versionsstaende zusaetzlich flach ablegen - die Anlagenkarten lesen
	// openhabian_version/openhab_version direkt aus dem Status.
	const versions = /** @type {Record<string, any> | undefined} */ (data.versions);
	const patch = /** @type {Record<string, any>} */ ({ ...data });
	const isFull = Object.prototype.hasOwnProperty.call(data, 'versions');
	if (isFull && versions && typeof versions === 'object') {
		if (versions.openhab) patch.openhab_version = String(versions.openhab);
		if (versions.openhabian) patch.openhabian_version = String(versions.openhabian);
		if (versions.gateway) patch.gateway_version = String(versions.gateway);
	}
	// Logzeilen in das Anzeigeformat der Anlagen-Detailseite bringen.
	if (Array.isArray(data.log_entries)) {
		patch.logs = data.log_entries
			.filter((/** @type {any} */ e) => e && typeof e === 'object')
			.map((/** @type {any} */ e) => ({
				ts: String(e.time ?? ''),
				level: String(e.level ?? ''),
				logger: String(e.logger ?? ''),
				msg: String(e.message ?? '')
			}));
		delete patch.log_entries;
	}

	const hash = createHash('sha256').update(token).digest('hex');
	const [site] = await sql`
		update battery_site set last_seen_at = now(),
			status = case when ${isFull} then ${sql.json(patch)}::jsonb
				|| jsonb_strip_nulls(jsonb_build_object('linux_password', status->'linux_password',
					'wifi_ssid', status->'wifi_ssid', 'wifi_password', status->'wifi_password'))
				else status || ${sql.json(patch)}::jsonb end
		where token_hash = ${hash}
		returning id`;
	if (!site) {
		console.log(`gateway status push abgelehnt (unbekannter Token): ${anlage || 'ohne Namen'}`);
		return json({ error: 'Unbekannter Token.' }, { status: 401 });
	}
	return json({ ok: true });
}
