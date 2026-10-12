// Gemeinsame Pruefung des GATEWAY_SYNC_TOKEN fuer die stack-internen
// Sync-Endpunkte (WireGuard-Peers, Cloud-Konten): Bearer-Token aus der
// Server-.env, Vergleich in konstanter Zeit.
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

/** @param {Request} request */
export function syncTokenOk(request) {
	const expected = env.GATEWAY_SYNC_TOKEN;
	if (!expected) return false;
	const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!given) return false;
	// Ueber den Hash vergleichen, damit auch die Laenge nichts verraet.
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}
