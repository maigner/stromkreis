import { redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) {
		redirect(303, '/');
	}
	const tenantId = locals.user.tenant_id;

	// Tagessummen der letzten 14 lokalen Tage (inkl. heute, unvollstaendig)
	const dayRows = await sql`
		select (m.measured_at at time zone 'Europe/Vienna')::date::text as day,
			mc.kind,
			sum(m.value)::float as kwh
		from measurement m
		join meter_code mc on mc.tenant_id = m.tenant_id and mc.id = m.meter_code_id
		where m.tenant_id = ${tenantId}
			and mc.kind is not null
			and m.measured_at >=
				(date_trunc('day', now() at time zone 'Europe/Vienna') - interval '13 days')
					at time zone 'Europe/Vienna'
		group by 1, 2
		order by 1
	`;

	/** @type {Map<string, {day: string, total_consumption: number, total_production: number, self_use: number, overshoot: number}>} */
	const byDay = new Map();
	for (const r of dayRows) {
		if (!byDay.has(r.day)) {
			byDay.set(r.day, { day: r.day, total_consumption: 0, total_production: 0, self_use: 0, overshoot: 0 });
		}
		const d = /** @type {any} */ (byDay.get(r.day));
		if (r.kind in d) d[r.kind] = r.kwh;
	}

	const sites = await sql`
		select b.id, b.name, b.inverter_profile, b.status,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online,
			extract(epoch from now() - b.last_seen_at)::int as seen_seconds_ago,
			mem.name as member_name
		from battery_site b
		left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
		where b.tenant_id = ${tenantId}
		order by b.name
	`;

	return {
		days: [...byDay.values()],
		sites: sites.map((s) => ({ ...s }))
	};
}
