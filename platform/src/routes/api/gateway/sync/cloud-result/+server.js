import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db.js';

/**
 * Ergebnis des Cloud-Konten-Syncs (deploy/openhab-cloud/cloud-sync.js).
 * Body: { "id": <battery_site.id>, "ok": true|false, "mode": "upsert"|"delete",
 *         "action"?: "...", "error"?: "..." }
 */
export async function POST({ request }) {
	const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!env.GATEWAY_SYNC_TOKEN || token !== env.GATEWAY_SYNC_TOKEN) {
		return json({ error: 'Nicht erlaubt' }, { status: 401 });
	}
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const id = Number(body?.id);
	if (!Number.isInteger(id)) return json({ error: "Feld 'id' fehlt" }, { status: 400 });
	const ok = body?.ok === true;
	const mode = body?.mode === 'delete' ? 'delete' : 'upsert';
	const error = typeof body?.error === 'string' ? body.error.slice(0, 500) : null;

	if (mode === 'delete') {
		// Konto entfernt (oder gab es nicht): Zustand zuruecksetzen; die
		// Anlage selbst loescht der Betreiber auf der Plattform.
		await sql`update battery_site set cloud_account_state = '',
				cloud_account_error = ${ok ? null : error}
			where id = ${id} and cloud_account_state = 'delete'`;
	} else if (ok) {
		await sql`update battery_site set cloud_account_state = 'created', cloud_account_error = null
			where id = ${id} and cloud_account_state in ('pending', 'reset')`;
	} else {
		await sql`update battery_site set cloud_account_state = 'error', cloud_account_error = ${error}
			where id = ${id} and cloud_account_state in ('pending', 'reset')`;
	}
	return json({ ok: true });
}
