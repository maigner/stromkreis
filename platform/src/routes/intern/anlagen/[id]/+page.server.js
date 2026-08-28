import { error, fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';
import { PROVISION_CODE_DAYS, describePhase, newProvisionCode } from '$lib/server/gateway-provision.js';
import { getImageStatus, startImageBuild } from '$lib/server/gateway-image.js';

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
			b.last_seen_at, b.setup_phase, b.setup_message, b.setup_phase_at, b.provision_code, b.provision_expires_at,
			b.provisioned_at, b.capacity_kwh, b.pv_kwp, b.inverter_username,
			(b.inverter_secret is not null) as has_inverter_secret,
			p.metering_point, p.direction as point_direction,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online,
			extract(epoch from now() - b.last_seen_at)::int as seen_seconds_ago,
			mem.name as member_name
		from battery_site b
		left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
		left join measurement_point p on p.tenant_id = b.tenant_id and p.id = b.measurement_point_id
		where b.tenant_id = ${tenantId} and b.id = ${id}
	`;
	if (!site) {
		error(404, 'Anlage nicht gefunden');
	}

	const phase = describePhase(site.setup_phase);
	return {
		site: {
			.../** @type {any} */ (site),
			setup_label: phase.label,
			setup_percent: phase.percent,
			code_valid: Boolean(site.provision_code && site.provision_expires_at && site.provision_expires_at > new Date()),
			image: await getImageStatus(/** @type {any} */ (site))
		}
	};
}

/** @type {import('./$types').Actions} */
export const actions = {
	// SD-Karten-Image bauen (dauert einige Minuten)
	image_bauen: async ({ locals, params }) => {
		if (!locals.user) redirect(303, '/');
		try {
			await startImageBuild(locals.user.tenant_id, Number(params.id));
		} catch (e) {
			return fail(409, { message: e instanceof Error ? e.message : 'Image-Bau fehlgeschlagen.' });
		}
		return { image_started: Number(params.id) };
	},

	// Neuer Einrichtungscode (abgelaufen, verloren oder Neuinstallation der SD-Karte)
	code_erneuern: async ({ locals, params }) => {
		if (!locals.user) redirect(303, '/');
		const code = newProvisionCode();
		const [site] = await sql`
			update battery_site set provision_code = ${code}, provision_expires_at = now() + make_interval(days => ${PROVISION_CODE_DAYS}),
				setup_phase = case when setup_phase = 'fertig' then 'neu' else setup_phase end
			where tenant_id = ${locals.user.tenant_id} and id = ${Number(params.id)}
			returning id
		`;
		if (!site) return fail(404, { message: 'Anlage nicht gefunden.' });
		return { code };
	},

	// Zugangsdaten des Wechselrichters hinterlegen (z. B. Fronius GEN24,
	// Benutzer "customer"): das Gateway holt sie einmalig ab, danach wird
	// das Passwort hier geloescht - es liegt dann nur noch am Gateway.
	wechselrichter_zugang: async ({ locals, params, request }) => {
		if (!locals.user) redirect(303, '/');
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim().slice(0, 100);
		const password = String(form.get('password') ?? '');
		if (!password || password.length > 200) {
			return fail(400, { message: 'Bitte das Passwort des Wechselrichters eingeben.' });
		}
		const [site] = await sql`
			update battery_site set inverter_username = ${username || null}, inverter_secret = ${password}
			where tenant_id = ${locals.user.tenant_id} and id = ${Number(params.id)}
			returning id
		`;
		if (!site) return fail(404, { message: 'Anlage nicht gefunden.' });
		return { secret_saved: true };
	}
};
