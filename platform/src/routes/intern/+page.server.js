import { fail, redirect } from '@sveltejs/kit';
import { createHash, randomBytes } from 'node:crypto';
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
		select b.id, b.name, b.inverter_profile, b.status, b.latitude, b.longitude, b.address,
			coalesce(b.last_seen_at > now() - interval '10 minutes', false) as online,
			extract(epoch from now() - b.last_seen_at)::int as seen_seconds_ago,
			mem.name as member_name
		from battery_site b
		left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
		where b.tenant_id = ${tenantId}
		order by b.name
	`;

	const [tenantLocation] = await sql`
		select latitude, longitude from tenant where id = ${tenantId}
	`;

	const members = await sql`
		select id, name from member where tenant_id = ${tenantId} order by name
	`;

	return {
		days: [...byDay.values()],
		sites: sites.map((s) => ({ ...s })),
		members: members.map((m) => ({ id: Number(m.id), name: String(m.name) })),
		center: /** @type {[number, number]} */ ([tenantLocation.longitude, tenantLocation.latitude])
	};
}

const PROFILES = ['fronius-symo', 'fronius-snapinverter', 'sigenergy', 'deye', 'victron'];

// Lokale Stunde Europe/Vienna als Dezimalzahl
function viennaHour() {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Vienna',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
	return Number(p.hour) + Number(p.minute) / 60;
}

// Sonnenverlauf wie im Demo-Datengenerator (grobe Glockenkurve)
function sunFactor(/** @type {number} */ hour) {
	if (hour < 6.2 || hour > 20.7) return 0;
	return Math.sin((Math.PI * (hour - 6.2)) / 14.5) ** 1.35;
}

// Zeitstempel im openhab.log-Format (lokale Zeit Europe/Vienna)
function logTs(/** @type {number} */ ms) {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Vienna',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${millis}`;
}

/** @type {import('./$types').Actions} */
export const actions = {
	// Einrichtungs-Assistent Schritt 3: Anlage anlegen, Token nur als Hash
	// speichern und einmalig zurueckgeben. Die Anlage bleibt offline
	// (last_seen_at null), bis der erste Status-Push kommt.
	anlegen: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const tenantId = locals.user.tenant_id;

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const address = String(form.get('address') ?? '').trim();
		const profile = String(form.get('profile') ?? '');
		const memberRaw = String(form.get('member_id') ?? '');
		const latitude = Number(form.get('latitude'));
		const longitude = Number(form.get('longitude'));
		const capacityKwh = Number(form.get('capacity_kwh'));
		const pvKwp = Number(form.get('pv_kwp'));

		if (!name || name.length > 80) {
			return fail(400, { message: 'Bitte einen Namen mit höchstens 80 Zeichen angeben.' });
		}
		if (!address) {
			return fail(400, { message: 'Bitte eine Adresse angeben.' });
		}
		if (!PROFILES.includes(profile)) {
			return fail(400, { message: 'Unbekanntes Wechselrichterprofil.' });
		}
		if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
			return fail(400, { message: 'Breiten- und Längengrad bitte als Dezimalzahlen angeben.' });
		}
		if (!Number.isFinite(capacityKwh) || capacityKwh <= 0 || capacityKwh > 200) {
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

		const token = randomBytes(24).toString('base64url');
		const tokenHash = createHash('sha256').update(token).digest('hex');
		const status = {
			inverter_type: profile,
			inverter_status: 'unknown',
			batterie_kapazitaet: capacityKwh,
			pv_kwp: pvKwp,
			min_battery_charge: 20
		};
		const [site] = await sql`
			insert into battery_site (tenant_id, member_id, name, inverter_profile, token_hash, status, latitude, longitude, address)
			values (${tenantId}, ${memberId}, ${name}, ${profile}, ${tokenHash}, ${status}, ${latitude}, ${longitude}, ${address})
			returning id
		`;

		return { id: site.id, token };
	},

	// Einrichtungs-Assistent Schritt 4: simulierter erster Status-Push des
	// Gateways (Demo-Mandant), danach gilt die Anlage als online.
	aktivieren: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/');
		const tenantId = locals.user.tenant_id;

		const form = await request.formData();
		const id = Number(form.get('site_id'));
		if (!Number.isInteger(id)) {
			return fail(400, { message: 'Anlage nicht gefunden.' });
		}
		const [site] = await sql`
			select id, status from battery_site where tenant_id = ${tenantId} and id = ${id}
		`;
		if (!site) {
			return fail(404, { message: 'Anlage nicht gefunden.' });
		}

		const now = Date.now();
		const pvKwp = Number(site.status?.pv_kwp) || 5;
		const profile = site.status?.inverter_type ?? 'fronius-symo';
		const pv = Math.round(pvKwp * 1000 * sunFactor(viennaHour()) * 0.7);
		const load = Math.round(500 + Math.random() * 700);
		const soc = Math.round(45 + Math.random() * 45);
		// Vorzeichen wie vom Wechselrichter: Batterie + = Entladen, - = Laden
		const battery = pv > load && soc < 95 ? -Math.min(3000, pv - load) : 0;
		const logs = [
			['INFO', 'org.openhab.core.Activator', 'openHAB 4.3.3 started'],
			['INFO', 'org.openhab.core.model.script.stromkreis', `Gateway-Profil '${profile}' geladen, Fail-Safe aktiv`],
			['INFO', 'org.openhab.core.model.script.stromkreis', 'Wechselrichter verbunden (Modbus TCP)'],
			['INFO', 'openhab.event.ItemStateChangedEvent', `Item 'Batterie_SOC' changed from NULL to ${soc}`],
			['INFO', 'openhab.event.ItemStateChangedEvent', `Item 'PV_Leistung' changed from NULL to ${pv}`],
			['INFO', 'org.openhab.core.model.script.stromkreis', 'Auto-Revert geprueft, Vorgabe nach 60 s abgelaufen'],
			['INFO', 'org.openhab.core.model.script.stromkreis', 'Status-Push an stromkreis.net gesendet (HTTP 200)']
		].map(([level, logger, msg], i, arr) => ({
			ts: logTs(now - (arr.length - i) * 9000),
			level,
			logger,
			msg
		}));
		const patch = {
			inverter_status: 'running',
			soc,
			battery_power_w: battery,
			pv_power_w: pv,
			load_power_w: load,
			grid_power_w: load - pv - battery,
			hauptschalter: 'ON',
			ladesperre_aktiv: 'OFF',
			openhab_version: '4.3.3',
			openhabian_version: '1.9.1',
			logs
		};
		await sql`
			update battery_site
			set last_seen_at = now(), status = status || ${sql.json(patch)}
			where tenant_id = ${tenantId} and id = ${id}
		`;

		return { online: true };
	}
};
