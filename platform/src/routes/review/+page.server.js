// Oeffentliche Seite fuer die App-Pruefung (Apple App Review, Google Play):
// zeigt Einrichtungslink und QR-Code der Demo-Anlage. Jeder Seitenaufruf
// erzeugt einen frischen Einmal-Code (createReviewSetupToken), damit der
// Pruefer nie einen schon verbrauchten Code vor sich hat.
import { createReviewSetupToken, qrSvg, REVIEW_TOKEN_HOURS } from '$lib/server/app-setup.js';
import { platformBaseUrl } from '$lib/server/gateway-provision.js';

// Bremse je Adresse: hoechstens REVIEW_RATE_MAX Codes je REVIEW_RATE_WINDOW_MS
// (ein Pruefer laedt die Seite ein paarmal, kein Bot tausendmal).
const REVIEW_RATE_MAX = 30;
const REVIEW_RATE_WINDOW_MS = 10 * 60 * 1000;
/** @type {Map<string, number[]>} */
const hits = new Map();

/** @param {string} ip */
function rateLimited(ip) {
	const now = Date.now();
	const recent = (hits.get(ip) ?? []).filter((t) => now - t < REVIEW_RATE_WINDOW_MS);
	if (recent.length >= REVIEW_RATE_MAX) {
		hits.set(ip, recent);
		return true;
	}
	recent.push(now);
	hits.set(ip, recent);
	if (hits.size > 1000) {
		for (const [k, v] of hits) if (!v.some((t) => now - t < REVIEW_RATE_WINDOW_MS)) hits.delete(k);
	}
	return false;
}

/** @type {import('./$types').PageServerLoad} */
export async function load({ setHeaders, getClientAddress }) {
	setHeaders({ 'cache-control': 'no-store' });
	let ip = 'unbekannt';
	try {
		ip = getClientAddress();
	} catch {
		// hinter Proxy ohne Adresse: gemeinsames Kontingent
	}
	if (rateLimited(ip)) {
		return { available: false, rate_limited: true };
	}
	const created = await createReviewSetupToken();
	if (!created) {
		return { available: false };
	}
	return {
		available: true,
		site_name: created.site_name,
		link: created.link,
		app_link: `stromkreis://setup?token=${encodeURIComponent(created.token)}&origin=${encodeURIComponent(platformBaseUrl())}`,
		qr: await qrSvg(created.link),
		valid_hours: REVIEW_TOKEN_HOURS
	};
}
