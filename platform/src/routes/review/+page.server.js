// Oeffentliche Seite fuer die App-Pruefung (Apple App Review, Google Play):
// zeigt Einrichtungslink und QR-Code der Demo-Anlage. Jeder Seitenaufruf
// erzeugt einen frischen Einmal-Code (createReviewSetupToken), damit der
// Pruefer nie einen schon verbrauchten Code vor sich hat.
import { createReviewSetupToken, qrSvg, REVIEW_TOKEN_HOURS } from '$lib/server/app-setup.js';
import { platformBaseUrl } from '$lib/server/gateway-provision.js';
import { clientKey, createRateLimiter } from '$lib/server/rate-limit.js';

// Bremse je Adresse: hoechstens 30 Codes in 10 Minuten (ein Pruefer laedt die
// Seite ein paarmal, kein Bot tausendmal).
const LIMITER = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000 });

/** @type {import('./$types').PageServerLoad} */
export async function load(event) {
	event.setHeaders({ 'cache-control': 'no-store' });
	if (LIMITER.hit(clientKey(event))) {
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
