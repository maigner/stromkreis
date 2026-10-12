import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { sql } from '$lib/server/db.js';
import { SETUP_PHASES } from '$lib/server/gateway-provision.js';
import { deleteImage } from '$lib/server/gateway-image.js';

// Fortschrittsmeldung des Gateways waehrend der Einrichtung:
// POST {token, phase, message?, inverter_type?, hostname?, version?, wg_public_key?, ssh_host_key?}.
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
	// SSH-Host-Key des Gateways (Phase tunnel, OpenSSH-Form): die Plattform
	// prueft ihn bei der Fernwartung; eine Neuinstallation meldet den neuen.
	const sshKey =
		typeof body.ssh_host_key === 'string' && /^ssh-ed25519 [A-Za-z0-9+/]{60,80}=*$/.test(body.ssh_host_key.trim())
			? body.ssh_host_key.trim()
			: null;
	// Mit "fertig" stirbt der Einrichtungscode: ein spaeterer Lauf der
	// Einrichtung (Paket-Update meldet die Phasen erneut) darf ihn nicht
	// wieder einloesbar machen; fuer eine Neuinstallation gibt es "Neuer Code".
	const [site] = await sql`
		update battery_site set setup_phase = ${phase}, setup_message = ${message}, setup_phase_at = now(),
			last_seen_at = now(), status = status || ${sql.json(/** @type {any} */ (patch))},
			provision_code = case when ${phase} = 'fertig' then null else provision_code end,
			wg_public_key = coalesce(${wgKey}, wg_public_key),
			ssh_host_key = coalesce(${sshKey}, ssh_host_key)
		where token_hash = ${hash}
		returning id, inverter_profile`;
	if (!site) return json({ error: 'Token unbekannt' }, { status: 401 });
	// Anlage ist online: das SD-Karten-Image hat seinen Zweck erfuellt, die
	// Datei (samt Metadaten) wird geloescht. Fuer einen Restore wird ohnehin
	// ein neuer Code und ein frisches Image gebraucht.
	if (phase === 'fertig') await deleteImage(Number(site.id)).catch(() => {});
	return json({ ok: true, inverter_profile: site.inverter_profile });
}
