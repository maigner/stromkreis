import { json } from '@sveltejs/kit';
import { syncTokenOk } from '$lib/server/sync-auth.js';
import { sql } from '$lib/server/db.js';
import { decrypt } from '$lib/server/secrets.js';

/**
 * Offene Cloud-Konten fuer den Konten-Sync im openHAB-Cloud-Container
 * (deploy/openhab-cloud/cloud-sync.js): Anlagen mit cloud_account_state
 * pending/reset (Konto anlegen bzw. Passwort setzen) oder delete (Konto
 * entfernen). Passwort und Secret kommen entschluesselt - der Endpunkt ist
 * mit GATEWAY_SYNC_TOKEN geschuetzt und wird nur stack-intern benutzt.
 * Das Ergebnis meldet der Sync an /api/gateway/sync/cloud-result.
 */
export async function GET({ request }) {
	if (!syncTokenOk(request)) {
		return json({ error: 'Nicht erlaubt' }, { status: 401 });
	}
	const rows = await sql`
		select id, cloud_username, cloud_password, cloud_uuid, cloud_secret, cloud_account_state
		from battery_site
		where cloud_account_state in ('pending', 'reset', 'delete')
			and coalesce(cloud_username, '') <> ''
		order by id`;
	const accounts = [];
	for (const r of rows) {
		if (r.cloud_account_state === 'delete') {
			accounts.push({ id: Number(r.id), mode: 'delete', username: r.cloud_username });
			continue;
		}
		try {
			accounts.push({
				id: Number(r.id),
				mode: 'upsert',
				username: r.cloud_username,
				password: decrypt(r.cloud_password),
				uuid: r.cloud_uuid,
				secret: decrypt(r.cloud_secret)
			});
		} catch {
			await sql`update battery_site set cloud_account_state = 'error',
					cloud_account_error = 'Passwort oder Secret nicht entschluesselbar (TOKEN_SECRET geaendert?)'
				where id = ${r.id}`;
		}
	}
	return json({ accounts });
}
