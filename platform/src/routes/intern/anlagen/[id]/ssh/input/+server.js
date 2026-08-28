import { json } from '@sveltejs/kit';
import { getSession, resize, writeInput } from '$lib/server/gateway-ssh.js';

/**
 * Eingabe der SSH-Konsole: Tastatur-Bytes (Base64) und Terminalgroesse.
 */
/** @type {import('./$types').RequestHandler} */
export async function POST({ locals, params, request }) {
	if (!locals.user) return json({ error: 'Nicht angemeldet.' }, { status: 401 });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const session = getSession(String(body?.sid || ''), locals.user.tenant_id, Number(params.id));
	if (!session) return json({ error: 'Sitzung nicht (mehr) vorhanden.' }, { status: 404 });
	if (typeof body.data === 'string' && body.data) writeInput(session, body.data);
	if (body.resize) resize(session, Number(body.resize.cols), Number(body.resize.rows));
	return json({ ok: true });
}
