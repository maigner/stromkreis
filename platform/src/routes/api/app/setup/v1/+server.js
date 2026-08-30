// Einloesen eines App-Einrichtungscodes durch die Stromkreis-App
// (unauthentifiziert, der Einmal-Token ist der Nachweis; POST, damit der
// Token nicht in Access-Logs landet). Kontrakt: docs/stromkreis-onboarding.md
// im App-Repository - Antwort {cloudUrl, username, password, siteName},
// Fehler als {error} mit menschenlesbarem Text, den die App woertlich anzeigt.
import { json } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';
import { hashToken } from '$lib/server/auth.js';
import { decrypt } from '$lib/server/secrets.js';
import { cloudBaseUrl } from '$lib/server/gateway-provision.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	let token = '';
	try {
		const body = await request.json();
		token = typeof body?.token === 'string' ? body.token.trim() : '';
	} catch {
		return json({ error: 'Ungültige Anfrage.' }, { status: 400 });
	}
	if (!token || token.length > 200) {
		return json({ error: 'Ungültige Anfrage.' }, { status: 400 });
	}

	const [row] = await sql`
		select t.id, b.name, b.cloud_username, b.cloud_password
		from app_setup_token t
		join battery_site b on b.tenant_id = t.tenant_id and b.id = t.site_id
		where t.token_hash = ${hashToken(token)} and t.used_at is null and t.expires_at > now()
	`;
	if (!row) {
		return json({ error: 'Der Einrichtungscode ist ungültig oder wurde bereits verwendet.' }, { status: 410 });
	}
	if (!row.cloud_username || !row.cloud_password) {
		// Token nicht verbrauchen: sobald das Cloud-Konto angelegt ist, funktioniert derselbe Code.
		return json({ error: 'Für diese Anlage ist noch kein Cloud-Konto eingerichtet. Bitte später erneut versuchen.' }, { status: 409 });
	}
	let password;
	try {
		password = decrypt(row.cloud_password);
	} catch {
		return json({ error: 'Zugangsdaten konnten nicht gelesen werden. Bitte den EEG-Betreiber kontaktieren.' }, { status: 500 });
	}

	// Erst jetzt einmalig verbrauchen; bei zwei gleichzeitigen Anfragen gewinnt eine.
	const [consumed] = await sql`
		update app_setup_token set used_at = now()
		where id = ${row.id} and used_at is null
		returning id
	`;
	if (!consumed) {
		return json({ error: 'Der Einrichtungscode ist ungültig oder wurde bereits verwendet.' }, { status: 410 });
	}

	return json({
		cloudUrl: cloudBaseUrl() ?? 'https://hac.stromkreis.net',
		username: row.cloud_username,
		password,
		siteName: row.name
	});
}
