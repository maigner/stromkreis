import { error, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, params }) {
	if (!locals.user) {
		redirect(303, '/');
	}
	const tenantId = locals.user.tenant_id;
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		error(404, 'Anlage nicht gefunden');
	}

	const [site] = await sql`
		select b.id, b.name, b.status,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online
		from battery_site b
		where b.tenant_id = ${tenantId} and b.id = ${id}
	`;
	if (!site) {
		error(404, 'Anlage nicht gefunden');
	}

	return { site: { ...site } };
}
