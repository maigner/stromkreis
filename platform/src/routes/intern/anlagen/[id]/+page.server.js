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
		select b.id, b.name, b.inverter_profile, b.status, b.latitude, b.longitude, b.address,
			b.last_seen_at,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online,
			extract(epoch from now() - b.last_seen_at)::int as seen_seconds_ago,
			mem.name as member_name
		from battery_site b
		left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
		where b.tenant_id = ${tenantId} and b.id = ${id}
	`;
	if (!site) {
		error(404, 'Anlage nicht gefunden');
	}

	return { site: { ...site } };
}
