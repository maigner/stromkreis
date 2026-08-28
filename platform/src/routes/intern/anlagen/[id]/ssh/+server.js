import { json } from '@sveltejs/kit';
import { closeSession, getSession, openSession } from '$lib/server/gateway-ssh.js';

/**
 * SSH-Konsole der Anlagen-Detailseite: Sitzung oeffnen bzw. schliessen.
 * Nur fuer angemeldete Betreiber, immer mandanten- und anlagengebunden.
 */

/** @param {App.Locals} locals @param {string} idParam */
function guard(locals, idParam) {
	if (!locals.user) return null;
	const siteId = Number(idParam);
	if (!Number.isInteger(siteId)) return null;
	return { tenantId: locals.user.tenant_id, siteId };
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ locals, params, request }) {
	const ctx = guard(locals, params.id);
	if (!ctx) return json({ error: 'Nicht angemeldet.' }, { status: 401 });
	let body = {};
	try {
		body = await request.json();
	} catch {}
	try {
		const { id } = await openSession(ctx.tenantId, ctx.siteId, {
			cols: Number(/** @type {any} */ (body).cols) || undefined,
			rows: Number(/** @type {any} */ (body).rows) || undefined
		});
		return json({ id });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'SSH-Verbindung fehlgeschlagen.' }, { status: 502 });
	}
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ locals, params, url }) {
	const ctx = guard(locals, params.id);
	if (!ctx) return json({ error: 'Nicht angemeldet.' }, { status: 401 });
	const sid = url.searchParams.get('sid') || '';
	if (getSession(sid, ctx.tenantId, ctx.siteId)) closeSession(sid);
	return json({ ok: true });
}
