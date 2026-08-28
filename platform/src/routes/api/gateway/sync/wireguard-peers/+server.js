import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db.js';

/**
 * Peer-Liste fuer den WireGuard-Container (deploy/wireguard/): alle Anlagen
 * mit gemeldetem Public-Key und zugeteilter Tunnel-IP, mandantenuebergreifend
 * (ein gemeinsames Wartungsnetz). Die DB ist die Registry; der Container
 * gleicht jede Minute ab (wg set/remove).
 *
 * Auth: Authorization: Bearer <GATEWAY_SYNC_TOKEN> (Server-.env, teilen sich
 * Plattform, WireGuard-Container und Cloud-Konten-Sync).
 */
export async function GET({ request }) {
	const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!env.GATEWAY_SYNC_TOKEN || token !== env.GATEWAY_SYNC_TOKEN) {
		return json({ error: 'Nicht erlaubt' }, { status: 401 });
	}
	const rows = await sql`
		select b.id, b.name, b.wg_address, b.wg_public_key, t.slug as tenant_slug
		from battery_site b
		join tenant t on t.id = b.tenant_id
		where b.wg_address is not null and coalesce(b.wg_public_key, '') <> ''
		order by b.wg_address`;
	return json({
		peers: rows
			.filter((r) => /^[A-Za-z0-9+/]{42,43}=$/.test(r.wg_public_key))
			.map((r) => ({
				id: Number(r.id),
				name: `${r.tenant_slug}/${r.name}`,
				address: r.wg_address,
				public_key: r.wg_public_key
			}))
	});
}
