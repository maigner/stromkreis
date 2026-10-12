import { sessionUser } from '$lib/server/auth.js';

// Sicherheits-Header fuer jede Antwort (Befund der Pruefung 10/2026): Caddy
// terminiert TLS, setzt aber von sich aus kein HSTS. Die CSP laeuft vorerst
// im Report-Only-Modus (maplibre braucht blob:-Worker und Kartenkacheln von
// fremden Hosts); scharf geschaltet wird sie, sobald die Berichte leer sind.
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; " +
	"worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
	const token = event.cookies.get('session');
	event.locals.user = token ? await sessionUser(token) : null;
	const response = await resolve(event);
	const h = response.headers;
	h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	h.set('X-Content-Type-Options', 'nosniff');
	h.set('X-Frame-Options', 'DENY');
	h.set('Referrer-Policy', 'no-referrer');
	h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (!h.has('Content-Security-Policy-Report-Only')) h.set('Content-Security-Policy-Report-Only', CSP);
	return response;
}
