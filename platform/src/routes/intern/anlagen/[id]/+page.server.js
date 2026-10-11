import { error, fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';
import { isOperator, requireOperator, requireUser } from '$lib/server/auth.js';
import { PROVISION_CODE_DAYS, describePhase, newProvisionCode, randomPhonePassword } from '$lib/server/gateway-provision.js';
import { decrypt, encrypt, readSecret } from '$lib/server/secrets.js';
import { getImageStatus, startImageBuild } from '$lib/server/gateway-image.js';
import { createAppSetupToken, qrSvg } from '$lib/server/app-setup.js';
import { listRemoteActions, runRemoteAction } from '$lib/server/gateway-ssh.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, params }) {
	const tenantId = requireUser(locals).tenant_id;
	const operator = isOperator(locals);
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		error(404, 'Anlage nicht gefunden');
	}

	// Geheimnisse (Einrichtungscode, Cloud- und Linux-Passwort) nur fuer
	// Betreiber; der Status ohne Altbestand an Passwortschluesseln.
	const [site] = await sql`
		select b.id, b.name, b.inverter_profile, b.status - 'linux_password' - 'wifi_ssid' - 'wifi_password' as status,
			b.latitude, b.longitude, b.address,
			b.last_seen_at, b.setup_phase, b.setup_message, b.setup_phase_at,
			case when ${operator} then b.provision_code end as provision_code, b.provision_expires_at,
			(b.provision_code is not null) as has_provision_code,
			b.provisioned_at, b.capacity_kwh, b.pv_kwp, b.inverter_username,
			(b.inverter_secret is not null) as has_inverter_secret,
			b.wg_address, (coalesce(b.wg_public_key, '') <> '') as wg_key_reported,
			b.cloud_username, case when ${operator} then b.cloud_password end as cloud_password,
			case when ${operator} then b.linux_secret end as linux_secret,
			b.cloud_account_state, b.cloud_account_error,
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

	// Gibt es einen noch gueltigen (unverbrauchten) App-Einrichtungscode?
	// Der Link selbst ist nicht rekonstruierbar (nur Hash gespeichert).
	const [appCode] = await sql`
		select created_at, expires_at from app_setup_token
		where tenant_id = ${tenantId} and site_id = ${id} and used_at is null and expires_at > now()
	`;

	const phase = describePhase(site.setup_phase);
	let cloudPassword = null;
	if (site.cloud_password) {
		try {
			cloudPassword = decrypt(site.cloud_password);
		} catch {
			cloudPassword = null;
		}
	}
	let linuxPassword = null;
	try {
		linuxPassword = readSecret(site.linux_secret);
	} catch {
		linuxPassword = null;
	}
	const { linux_secret: _omit, ...publicSite } = /** @type {any} */ (site);
	return {
		site: {
			...publicSite,
			cloud_password: cloudPassword,
			linux_password: linuxPassword,
			setup_label: phase.label,
			setup_percent: phase.percent,
			code_valid: Boolean(site.has_provision_code && site.provision_expires_at && site.provision_expires_at > new Date()),
			app_code: appCode ?? null,
			image: await getImageStatus(/** @type {any} */ (site))
		},
		remote_actions: operator ? listRemoteActions() : []
	};
}

/** @type {import('./$types').Actions} */
export const actions = {
	// SD-Karten-Image bauen (dauert einige Minuten)
	image_bauen: async ({ locals, params }) => {
		const user = requireOperator(locals);
		try {
			await startImageBuild(user.tenant_id, Number(params.id));
		} catch (e) {
			return fail(409, { message: e instanceof Error ? e.message : 'Image-Bau fehlgeschlagen.' });
		}
		return { image_started: Number(params.id) };
	},

	// Neuer Einrichtungscode (abgelaufen, verloren oder Neuinstallation der SD-Karte)
	code_erneuern: async ({ locals, params }) => {
		const user = requireOperator(locals);
		const code = newProvisionCode();
		const [site] = await sql`
			update battery_site set provision_code = ${code}, provision_expires_at = now() + make_interval(days => ${PROVISION_CODE_DAYS}),
				setup_phase = case when setup_phase = 'fertig' then 'neu' else setup_phase end
			where tenant_id = ${user.tenant_id} and id = ${Number(params.id)}
			returning id
		`;
		if (!site) return fail(404, { message: 'Anlage nicht gefunden.' });
		return { code };
	},

	// Zugangsdaten des Wechselrichters hinterlegen (z. B. Fronius GEN24,
	// Benutzer "customer"): das Gateway holt sie bei der Einrichtung ab.
	// Das Passwort bleibt verschluesselt (TOKEN_SECRET) gespeichert, damit
	// eine Neuinstallation es ohne erneutes Eintragen wieder abholen kann.
	wechselrichter_zugang: async ({ locals, params, request }) => {
		const user = requireOperator(locals);
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim().slice(0, 100);
		const password = String(form.get('password') ?? '');
		if (!password || password.length > 200) {
			return fail(400, { message: 'Bitte das Passwort des Wechselrichters eingeben.' });
		}
		const [site] = await sql`
			update battery_site set inverter_username = ${username || null}, inverter_secret = ${encrypt(password)}
			where tenant_id = ${user.tenant_id} and id = ${Number(params.id)}
			returning id
		`;
		if (!site) return fail(404, { message: 'Anlage nicht gefunden.' });
		return { secret_saved: true };
	},

	// Neues Passwort fuer das Cloud-Konto der Anlage: der Konten-Sync im
	// Cloud-Container setzt es innerhalb einer Minute (Zustand reset).
	cloud_passwort_neu: async ({ locals, params }) => {
		const user = requireOperator(locals);
		const password = randomPhonePassword();
		const [site] = await sql`
			update battery_site set cloud_password = ${encrypt(password)},
				cloud_account_state = 'reset', cloud_account_error = null
			where tenant_id = ${user.tenant_id} and id = ${Number(params.id)}
				and coalesce(cloud_username, '') <> ''
			returning id
		`;
		if (!site) return fail(404, { message: 'Anlage hat noch kein Cloud-Konto.' });
		return { cloud_password_reset: true };
	},

	// Einmal-Code fuer die App-Einrichtung: QR-Code/Link, mit dem die
	// Stromkreis-App die Cloud-Zugangsdaten der Anlage abholt. Ersetzt einen
	// eventuell bestehenden Code; Link und QR werden nur einmal angezeigt.
	app_code_erzeugen: async ({ locals, params }) => {
		const user = requireOperator(locals);
		const created = await createAppSetupToken(user.tenant_id, Number(params.id));
		if (!created) return fail(404, { message: 'Anlage nicht gefunden.' });
		return {
			app_setup: {
				link: created.link,
				expires_at: created.expires_at,
				qr: await qrSvg(created.link)
			}
		};
	},

	// Fernwartung: eine der festen Wartungsaktionen per SSH am Gateway
	// ausfuehren (Neustart, Updates, Abfragen). Vom Browser kommt nur die
	// Kennung; die Befehle selbst stehen in gateway-ssh.js.
	fernwartung: async ({ locals, params, request }) => {
		const user = requireOperator(locals);
		const form = await request.formData();
		const actionId = String(form.get('aktion') ?? '');
		try {
			return { remote: await runRemoteAction(user.tenant_id, Number(params.id), actionId) };
		} catch (e) {
			return fail(502, {
				remote_error: e instanceof Error ? e.message : 'Fernwartung fehlgeschlagen.',
				remote_action: actionId
			});
		}
	}
};
