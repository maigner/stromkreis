import { json } from '@sveltejs/kit';
import { getSession, outputStream } from '$lib/server/gateway-ssh.js';

/**
 * Terminalausgabe der SSH-Sitzung als Server-Sent-Events-Strom
 * (Base64-Chunks; das Ende der Sitzung kommt als Event `end`).
 */
/** @type {import('./$types').RequestHandler} */
export function GET({ locals, params, url }) {
	if (!locals.user) return json({ error: 'Nicht angemeldet.' }, { status: 401 });
	const session = getSession(url.searchParams.get('sid') || '', locals.user.tenant_id, Number(params.id));
	if (!session) return json({ error: 'Sitzung nicht (mehr) vorhanden.' }, { status: 404 });
	return new Response(outputStream(session), {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}
