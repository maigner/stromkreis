import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { sql } from '$lib/server/db.js';

/**
 * Einmalige Auslieferung der Wechselrichter-Zugangsdaten an das Gateway
 * (02b-install-things.sh fragt in der Phase wartet_auf_passwort alle zwei
 * Minuten nach). Der Betreiber traegt Benutzer und Passwort auf der
 * Anlagen-Detailseite ein; nach der Auslieferung wird das Passwort auf der
 * Plattform geloescht - es liegt dann nur noch am Gateway (Bridge-Thing).
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
		with alt as (
			select id, inverter_username, inverter_secret
			from battery_site where token_hash = ${hash}
		)
		update battery_site b set inverter_secret = null
		from alt
		where b.id = alt.id and alt.inverter_secret is not null
		returning alt.inverter_username as username, alt.inverter_secret as password`;
	if (!row) return json({});
	return json({ username: row.username ?? '', password: row.password });
}
