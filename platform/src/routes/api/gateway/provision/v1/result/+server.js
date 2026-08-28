import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { sql } from '$lib/server/db.js';
import { SETUP_PHASES } from '$lib/server/gateway-provision.js';

// Fortschrittsmeldung des Gateways waehrend der Einrichtung:
// POST {token, phase, message?, inverter_type?, hostname?, version?}.
// Authentifizierung ueber den Anlagen-Token aus der Provisionierung.
// Antwort traegt Vorgaben der Plattform (z.B. vom Betreiber gesetztes Profil).
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const token = typeof body?.token === 'string' ? body.token : '';
	const phase = typeof body?.phase === 'string' ? body.phase.trim() : '';
	if (!token || !phase) return json({ error: 'token und phase erforderlich' }, { status: 400 });
	if (!SETUP_PHASES[phase] && !/^fehler:[a-z_]{1,40}$/.test(phase)) return json({ error: 'Unbekannte Phase' }, { status: 400 });
	const hash = createHash('sha256').update(token).digest('hex');
	const message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;
	const patch = /** @type {Record<string, unknown>} */ ({});
	if (typeof body.inverter_type === 'string') patch.inverter_type = body.inverter_type.slice(0, 40);
	if (typeof body.hostname === 'string') patch.hostname = body.hostname.slice(0, 63);
	if (typeof body.version === 'string') patch.version = body.version.slice(0, 40);
	// WireGuard-Public-Key der Anlage (Phase tunnel): der WireGuard-Container
	// am Server liest die Peers ueber /api/gateway/sync/wireguard-peers.
	const wgKey =
		typeof body.wg_public_key === 'string' && /^[A-Za-z0-9+/]{42,43}=$/.test(body.wg_public_key.trim())
			? body.wg_public_key.trim()
			: null;
	const [site] = await sql`
		update battery_site set setup_phase = ${phase}, setup_message = ${message}, setup_phase_at = now(),
			last_seen_at = now(), status = status || ${sql.json(/** @type {any} */ (patch))},
			wg_public_key = coalesce(${wgKey}, wg_public_key)
		where token_hash = ${hash}
		returning id, inverter_profile`;
	if (!site) return json({ error: 'Token unbekannt' }, { status: 401 });
	return json({ ok: true, inverter_profile: site.inverter_profile });
}
