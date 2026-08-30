// Oeffentliche Fallback-Seite fuer den App-Einrichtungslink: landet das
// Mitglied im Browser (App nicht installiert oder Desktop), zeigt die Seite
// die Schritte, einen "In der App öffnen"-Knopf (stromkreis://) und den
// QR-Code mit der eigenen URL. Der Token wird hier NUR geprueft, nie
// verbraucht - das macht erst die App via POST /api/app/setup/v1.
import { sql } from '$lib/server/db.js';
import { hashToken } from '$lib/server/auth.js';
import { appSetupLink, qrSvg } from '$lib/server/app-setup.js';
import { platformBaseUrl } from '$lib/server/gateway-provision.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
	const token = params.token;
	if (!token || token.length > 200) {
		return { valid: false };
	}
	const [row] = await sql`
		select t.expires_at, b.name as site_name
		from app_setup_token t
		join battery_site b on b.tenant_id = t.tenant_id and b.id = t.site_id
		where t.token_hash = ${hashToken(token)} and t.used_at is null and t.expires_at > now()
	`;
	if (!row) {
		return { valid: false };
	}
	const link = appSetupLink(token);
	return {
		valid: true,
		site_name: /** @type {string} */ (row.site_name),
		expires_at: /** @type {Date} */ (row.expires_at),
		app_link: `stromkreis://setup?token=${encodeURIComponent(token)}&origin=${encodeURIComponent(platformBaseUrl())}`,
		qr: await qrSvg(link)
	};
}
