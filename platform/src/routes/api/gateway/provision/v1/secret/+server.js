import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { sql } from '$lib/server/db.js';
import { decrypt } from '$lib/server/secrets.js';

/**
 * Auslieferung der Wechselrichter-Zugangsdaten an das Gateway
 * (02b-install-things.sh fragt in der Phase wartet_auf_passwort alle zwei
 * Minuten nach). Der Betreiber traegt Benutzer und Passwort auf der
 * Anlagen-Detailseite ein; das Passwort bleibt verschluesselt (TOKEN_SECRET)
 * auf der Plattform gespeichert, damit eine Neuinstallation (z. B. neue
 * SD-Karte nach Pi-Defekt) es ohne erneutes Eintragen wieder abholen kann.
 * Wer den Anlagen-Token hat, kann es abrufen - der Token liegt ohnehin nur
 * am Gateway (gateway.conf, root-only), das das Passwort selbst kennt.
 *
 * Body: { "token": "<geheim>" }. Antwort: { username, password }, solange
 * ein Passwort hinterlegt ist, sonst {} (das Gateway fragt dann weiter).
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const token = typeof body?.token === 'string' ? body.token.trim() : '';
	if (!token || token.length > 200) {
		return json({ error: "Feld 'token' fehlt oder ist ungültig" }, { status: 400 });
	}
	const hash = createHash('sha256').update(token).digest('hex');
	const [row] = await sql`
		select inverter_username as username, inverter_secret as password
		from battery_site where token_hash = ${hash} and inverter_secret is not null`;
	if (!row) return json({});
	// Altbestand vor der Verschluesselung lag im Klartext in der Datenbank.
	const password = row.password.startsWith('enc1:') ? decrypt(row.password) : row.password;
	return json({ username: row.username ?? '', password });
}
