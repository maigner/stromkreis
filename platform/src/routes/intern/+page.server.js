import { fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';
import { PROVISION_CODE_DAYS, describePhase, newProvisionCode, newSiteToken, randomPassword } from '$lib/server/gateway-provision.js';
import { getImageStatus, startImageBuild } from '$lib/server/gateway-image.js';
import { loadEnergie } from '$lib/server/energie.js';
import { loadPrognose } from '$lib/server/prognose.js';

const TABS = ['anlagen', 'standorte', 'energie', 'prognose'];

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, url }) {
	if (!locals.user) {
		redirect(303, '/');
	}
	const tenantId = locals.user.tenant_id;

	// Aktiver Tab aus der URL (?tab=), damit die Energie-Auswertung nur bei Bedarf
	// gerechnet wird und Tab-Links bzw. Lesezeichen funktionieren
	const tabRaw = url.searchParams.get('tab') ?? 'anlagen';
	const tab = /** @type {'anlagen' | 'standorte' | 'energie' | 'prognose'} */ (TABS.includes(tabRaw) ? tabRaw : 'anlagen');
	const energie = tab === 'energie' ? await loadEnergie(tenantId) : null;
	const prognose = tab === 'prognose' ? await loadPrognose(tenantId) : null;

	const sites = await sql`
		select b.id, b.name, b.inverter_profile, b.status, b.latitude, b.longitude, b.address, b.last_seen_at,
			b.setup_phase, b.setup_message, b.provision_code, b.provision_expires_at,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online,
			extract(epoch from now() - b.last_seen_at)::int as seen_seconds_ago,
			mem.name as member_name
		from battery_site b
		left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
		where b.tenant_id = ${tenantId}
		order by b.name
	`;

	const [tenantLocation] = await sql`
		select latitude, longitude, slug from tenant where id = ${tenantId}
	`;

	const members = await sql`
		select m.id, m.name, m.participant_number, m.address,
			exists (select 1 from battery_site b where b.tenant_id = m.tenant_id and b.member_id = m.id) as has_site,
			coalesce(json_agg(json_build_object('id', p.id, 'metering_point', p.metering_point, 'direction', p.direction)
				order by p.direction, p.metering_point) filter (where p.id is not null), '[]') as points
		from member m
		left join measurement_point p on p.tenant_id = m.tenant_id and p.member_id = m.id
		where m.tenant_id = ${tenantId} and m.role = 'member'
		group by m.id
		order by m.participant_number nulls last, m.name
	`;

	// Letzter Import-Auftrag (laufend oder abgeschlossen) fuer die Statusanzeige
	const [sync] = await sql`
		select id, phase, full_import, progress, error, requested_at, started_at, heartbeat_at, finished_at
		from eegfaktura_sync_job where tenant_id = ${tenantId}
		order by requested_at desc limit 1
	`;

	// Gesamtzeitraum der vorhandenen Energiedaten (fuer die Statusanzeige)
	const [dataRange] = sync
		? await sql`select min(day)::text as first_day, max(day)::text as last_day from measurement_daily where tenant_id = ${tenantId}`
		: [null];

	const [{ n: switchable }] = await sql`
		select count(distinct m2.tenant_id) as n
		from member m1 join member m2 on m2.role = 'operator'
			and (m2.oidc_sub = m1.oidc_sub or (m1.email is not null and m2.email = m1.email))
		where m1.tenant_id = ${tenantId} and m1.id = ${locals.user.member_id}
	`;

	return {
		tab,
		energie,
		prognose,
		sites: await Promise.all(sites.map(async (s) => ({
			.../** @type {any} */ (s),
			setup_percent: describePhase(s.setup_phase).percent,
			setup_label: describePhase(s.setup_phase).label,
			provision_expires_at: s.provision_expires_at ? /** @type {Date} */ (s.provision_expires_at).toISOString() : null,
			image: await getImageStatus(/** @type {any} */ (s))
		}))),
		members: members.map((m) => ({
			id: Number(m.id),
			name: String(m.name),
			participant_number: /** @type {string | null} */ (m.participant_number),
			address: /** @type {string | null} */ (m.address),
			has_site: Boolean(m.has_site),
			points: /** @type {{ id: number, metering_point: string, direction: string }[]} */ (m.points)
		})),
		center: /** @type {[number, number]} */ ([tenantLocation.longitude, tenantLocation.latitude]),
		sync: sync
			? {
					id: Number(sync.id),
					phase: /** @type {string} */ (sync.phase),
					full_import: Boolean(sync.full_import),
					progress: /** @type {Record<string, any>} */ (sync.progress ?? {}),
					error: /** @type {string | null} */ (sync.error),
					requested_at: /** @type {Date} */ (sync.requested_at).toISOString(),
					finished_at: sync.finished_at ? /** @type {Date} */ (sync.finished_at).toISOString() : null,
					heartbeat_at: sync.heartbeat_at ? /** @type {Date} */ (sync.heartbeat_at).toISOString() : null,
					data_first_day: /** @type {string | null} */ (dataRange?.first_day ?? null),
					data_last_day: /** @type {string | null} */ (dataRange?.last_day ?? null)
				}
			: null,
		canSwitch: Number(switchable) > 1
	};
}

const PROFILES = ['fronius-symo', 'fronius-snapinverter', 'sigenergy', 'deye', 'victron'];

/** @type {import('./$types').Actions} */
export const actions = {
	// Einrichtungs-Assistent Schritt 2: Anlage anlegen. Einrichtungscode (60 Tage)
	// und Linux-Passwort fuer die SD-Karte; der Anlagen-Token entsteht erst beim
	// Erstkontakt des Gateways (nur Hash gespeichert). Die Anlage bleibt offline
	// (last_seen_at null), bis der erste Status-Push kommt.
	anlegen: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const tenantId = locals.user.tenant_id;

		const form = await request.formData();
		let name = String(form.get('name') ?? '').trim();
		let address = String(form.get('address') ?? '').trim();
		const profile = String(form.get('profile') ?? '');
		const memberRaw = String(form.get('member_id') ?? '');
		// Kapazitaet ohne Angabe bleibt leer ("k.A."), bis das Gateway sie meldet
		const capacityKwh = String(form.get('capacity_kwh') ?? '').trim() === '' ? null : Number(form.get('capacity_kwh'));
		const pvKwp = String(form.get('pv_kwp') ?? '').trim() === '' ? 0 : Number(form.get('pv_kwp'));

		// Schnellformular (Anlagen-Tab, nur Mitglied und Wechselrichtertyp): Name und Adresse
		// aus dem Mitglied, Standort vom Gemeinschafts-Mittelpunkt, Zaehlpunkt = Erzeugung des Mitglieds
		let memberAddress = null;
		let memberName = null;
		/** @type {[number, number] | null} Koordinaten des Mitglieds (Geokodierung durch den Worker) */
		let memberCoords = null;
		if (memberRaw !== '') {
			const [m] = await sql`select name, address, latitude, longitude from member where tenant_id = ${tenantId} and id = ${Number(memberRaw)}`;
			memberAddress = m?.address ?? null;
			memberName = m?.name ?? null;
			if (m?.latitude != null && m?.longitude != null) memberCoords = [Number(m.latitude), Number(m.longitude)];
		}
		if (!address && memberAddress) address = memberAddress;
		if (!name && memberName) name = `Anlage ${memberName}`;
		let latitude = Number(form.get('latitude'));
		let longitude = Number(form.get('longitude'));
		if (String(form.get('latitude') ?? '') === '' || String(form.get('longitude') ?? '') === '') {
			// Standort: Mitgliedskoordinaten (geokodierte EEG-Faktura-Adresse), sonst der
			// Gemeinschafts-Mittelpunkt; solche Anlagen zieht der Worker nach, sobald das
			// Mitglied Koordinaten hat.
			if (memberCoords) {
				[latitude, longitude] = memberCoords;
			} else {
				const [t] = await sql`select latitude, longitude from tenant where id = ${tenantId}`;
				latitude = Number(t.latitude);
				longitude = Number(t.longitude);
			}
		}
		const pointRaw = String(form.get('measurement_point_id') ?? '');
		const wifiSsid = String(form.get('wifi_ssid') ?? '').trim().slice(0, 32) || null;
		const wifiPassword = wifiSsid ? String(form.get('wifi_password') ?? '').slice(0, 63) : null;

		if (!name || name.length > 80) {
			return fail(400, { message: 'Bitte einen Namen mit höchstens 80 Zeichen angeben.' });
		}
		if (!address) {
			return fail(400, { message: 'Bitte eine Adresse angeben (das Mitglied hat keine hinterlegt).' });
		}
		if (!PROFILES.includes(profile)) {
			return fail(400, { message: 'Unbekanntes Wechselrichterprofil.' });
		}
		if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
			return fail(400, { message: 'Breiten- und Längengrad bitte als Dezimalzahlen angeben.' });
		}
		if (capacityKwh != null && (!Number.isFinite(capacityKwh) || capacityKwh <= 0 || capacityKwh > 200)) {
			return fail(400, { message: 'Batteriekapazität bitte in kWh angeben (bis 200).' });
		}
		if (!Number.isFinite(pvKwp) || pvKwp < 0 || pvKwp > 500) {
			return fail(400, { message: 'PV-Leistung bitte in kWp angeben (bis 500).' });
		}

		let memberId = null;
		if (memberRaw !== '') {
			const [member] = await sql`
				select id from member where tenant_id = ${tenantId} and id = ${Number(memberRaw)}
			`;
			if (!member) {
				return fail(400, { message: 'Mitglied nicht gefunden.' });
			}
			memberId = member.id;
		}

		let pointId = null;
		if (!form.has('measurement_point_id') && memberId !== null) {
			const [point] = await sql`
				select id from measurement_point where tenant_id = ${tenantId} and member_id = ${memberId}
				order by (direction = 'generation') desc, metering_point limit 1
			`;
			pointId = point?.id ?? null;
		} else if (pointRaw !== '' && memberId !== null) {
			const [point] = await sql`
				select id from measurement_point where tenant_id = ${tenantId} and id = ${Number(pointRaw)} and member_id = ${memberId}
			`;
			if (!point) {
				return fail(400, { message: 'Zählpunkt gehört nicht zum gewählten Mitglied.' });
			}
			pointId = point.id;
		}

		const { hash: tokenHash } = newSiteToken(); // Platzhalter bis zum Erstkontakt des Gateways
		const status = {
			inverter_type: profile,
			inverter_status: 'unknown',
			...(capacityKwh == null ? {} : { batterie_kapazitaet: capacityKwh }),
			pv_kwp: pvKwp,
			min_battery_charge: 20,
			linux_password: randomPassword(),
			wifi_ssid: wifiSsid,
			wifi_password: wifiPassword
		};
		const code = newProvisionCode();
		const [site] = await sql`
			insert into battery_site (tenant_id, member_id, measurement_point_id, name, inverter_profile, token_hash, status,
				latitude, longitude, address, capacity_kwh, pv_kwp, provision_code, provision_expires_at, setup_phase)
			values (${tenantId}, ${memberId}, ${pointId}, ${name}, ${profile}, ${tokenHash}, ${status},
				${latitude}, ${longitude}, ${address}, ${capacityKwh}, ${pvKwp}, ${code},
				now() + make_interval(days => ${PROVISION_CODE_DAYS}), 'neu')
			returning id, provision_expires_at
		`;

		return { id: site.id, code, expires: /** @type {Date} */ (site.provision_expires_at).toISOString() };
	},

	// SD-Karten-Image einer Anlage bauen (dauert einige Minuten; Fortschritt
	// kommt ueber die Image-Statusanzeige der Anlage).
	image_bauen: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const form = await request.formData();
		const id = Number(form.get('site_id'));
		if (!Number.isInteger(id)) return fail(400, { message: 'Anlage nicht gefunden.' });
		try {
			await startImageBuild(locals.user.tenant_id, id);
		} catch (e) {
			return fail(409, { message: e instanceof Error ? e.message : 'Image-Bau fehlgeschlagen.' });
		}
		return { image_started: id };
	},

	// Neuen Einrichtungscode fuer eine Anlage (abgelaufen oder verloren).
	code_erneuern: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const form = await request.formData();
		const id = Number(form.get('site_id'));
		if (!Number.isInteger(id)) return fail(400, { message: 'Anlage nicht gefunden.' });
		const code = newProvisionCode();
		const [site] = await sql`
			update battery_site set provision_code = ${code}, provision_expires_at = now() + make_interval(days => ${PROVISION_CODE_DAYS}),
				setup_phase = case when setup_phase = 'fertig' then 'neu' else setup_phase end
			where tenant_id = ${locals.user.tenant_id} and id = ${id}
			returning id, provision_expires_at
		`;
		if (!site) return fail(404, { message: 'Anlage nicht gefunden.' });
		return { id: site.id, code, expires: /** @type {Date} */ (site.provision_expires_at).toISOString() };
	}
};
