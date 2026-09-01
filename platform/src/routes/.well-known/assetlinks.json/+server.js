// Digital Asset Links fuer Android App Links der Stromkreis-App
// (Fork der openHAB-App, Application-IDs net.stromkreis.app und
// net.stromkreis.app.beta): https://stromkreis.net/app/setup/<token> oeffnet
// direkt die App, sobald die Datei live ist und die SHA-256-Fingerabdruecke
// der Signaturzertifikate stimmen. Muss ohne Redirect als application/json
// ausgeliefert werden. Gegenstueck zu apple-app-site-association (iOS).
//
// Fingerabdruecke kommen aus ANDROID_APP_CERT_SHA256 (kommagetrennt, Format
// "AA:BB:...", z.B. aus `keytool -list -v -keystore release.jks` bzw. dem
// App-Signing-Zertifikat in der Play Console). Ohne Konfiguration wird eine
// leere Liste geliefert; stromkreis://-Links funktionieren unabhaengig davon.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const prerender = false;

const PACKAGES = ['net.stromkreis.app', 'net.stromkreis.app.beta'];

/** @type {import('./$types').RequestHandler} */
export function GET() {
	const fingerprints = (env.ANDROID_APP_CERT_SHA256 ?? '')
		.split(',')
		.map((f) => f.trim().toUpperCase())
		.filter((f) => f.length > 0);
	if (fingerprints.length === 0) {
		return json([]);
	}
	return json(
		PACKAGES.map((package_name) => ({
			relation: ['delegate_permission/common.handle_all_urls'],
			target: { namespace: 'android_app', package_name, sha256_cert_fingerprints: fingerprints }
		}))
	);
}
