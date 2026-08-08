#!/usr/bin/env node
// Demo-Datengenerator fuer den Demo-Mandanten (Salzkammerstrom): erfundene,
// aber plausible Daten fuer Dashboards und Vorfuehrung. Erzeugt Mitglieder,
// Zaehlpunkte, EEG-Faktura-Kategorien, 15-Minuten-Reihen (35 Tage), Stunden-
// wetter und openHABian-Anlagen mit Status. Deterministisch (fester Seed),
// erneutes Ausfuehren ersetzt die Demo-Daten vollstaendig; Betreiber- und
// Vorstandskonten bleiben erhalten.
// Aufruf: node scripts/demo-data.js seed [tenant-slug]   (Default: salzkammerstrom)
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL ist nicht gesetzt.');
	process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

const DAYS = 35;
const STEP = 900 * 1000; // 15 Minuten

// Deterministischer Zufall (mulberry32), damit der Seed reproduzierbar ist
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(42);

// Lokale Zeit Europe/Vienna je UTC-Instant (Datum als String, Stunde dezimal)
const fmt = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Vienna',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23'
});
function localParts(ms) {
	const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return {
		date: `${p.year}-${p.month}-${p.day}`,
		hour: Number(p.hour) + Number(p.minute) / 60
	};
}

// Sonnenverlauf im August (grobe Glockenkurve ueber die lokale Stunde)
function sunFactor(hour) {
	if (hour < 6.2 || hour > 20.7) return 0;
	return Math.sin((Math.PI * (hour - 6.2)) / 14.5) ** 1.35;
}

// Haushaltsprofil in kW (Grundlast, Morgen- und Abendspitze)
function householdKw(hour, r) {
	const morning = 0.55 * Math.exp(-((hour - 7.5) ** 2) / 3);
	const evening = 0.95 * Math.exp(-((hour - 19.2) ** 2) / 6);
	return (0.22 + morning + evening) * (0.75 + 0.5 * r);
}

// Gewerbeprofil in kW (Werktagsplateau)
function businessKw(hour, r) {
	const plateau = hour >= 7 && hour <= 17.5 ? 1 : hour > 17.5 && hour < 20 ? 0.4 : 0.15;
	return (0.5 + 2.8 * plateau) * (0.85 + 0.3 * r);
}

const MEMBERS = [
	'Anna Gruber', 'Josef Wallner', 'Maria Leitner', 'Franz Eder', 'Elisabeth Hofer',
	'Karl Brandstaetter', 'Sophie Aigner', 'Peter Loidl', 'Theresa Puehringer', 'Gasthof Seeblick'
];

// (Mitglied-Index, Richtung, Profil): 12 Verbrauchs- und 3 Erzeugungspunkte
const POINTS = [
	{ member: 0, direction: 'consumption', profile: 'household' },
	{ member: 1, direction: 'consumption', profile: 'household' },
	{ member: 2, direction: 'consumption', profile: 'household' },
	{ member: 3, direction: 'consumption', profile: 'household' },
	{ member: 4, direction: 'consumption', profile: 'household' },
	{ member: 5, direction: 'consumption', profile: 'household' },
	{ member: 6, direction: 'consumption', profile: 'household' },
	{ member: 7, direction: 'consumption', profile: 'household' },
	{ member: 8, direction: 'consumption', profile: 'household' },
	{ member: 9, direction: 'consumption', profile: 'business' },
	{ member: 9, direction: 'consumption', profile: 'business' },
	{ member: 3, direction: 'consumption', profile: 'household' },
	{ member: 1, direction: 'generation', profile: 'pv', kwp: 18 },
	{ member: 6, direction: 'generation', profile: 'pv', kwp: 30 },
	{ member: 9, direction: 'generation', profile: 'pv', kwp: 12 }
];

// Kategorien wie von EEG-Faktura geliefert; kind ist der stabile Schluessel
const METER_CODES = [
	{ kind: 'total_consumption', description: 'Gesamtverbrauch lt. Messung (bei Teilnahme gem. Erzeugung)' },
	{ kind: 'production_share', description: 'Anteil gemeinschaftliche Erzeugung' },
	{ kind: 'self_use', description: 'Eigendeckung gemeinschaftliche Erzeugung' },
	{ kind: 'total_production', description: 'Gesamte gemeinschaftliche Erzeugung' },
	{ kind: 'overshoot', description: 'Gesamt/Überschusserzeugung, Gemeinschaftsüberschuss' }
];

const SITES = [
	{
		name: 'Anlage Pfandl', profile: 'fronius-symo', member: 1, capacityKwh: 11, minutesAgo: 2,
		soc: 76, battery_w: -1450, pv_kwp: 18
	},
	{
		name: 'Anlage Kaltenbach', profile: 'sigenergy', member: 6, capacityKwh: 16, minutesAgo: 1,
		soc: 64, battery_w: -2100, pv_kwp: 30
	},
	{
		name: 'Anlage Reiterndorf', profile: 'victron', member: 4, capacityKwh: 7.7, minutesAgo: 187,
		soc: 41, battery_w: 380, pv_kwp: 0
	}
];

async function seed(slug) {
	const [tenant] = await sql`select id, slug, name from tenant where slug = ${slug}`;
	if (!tenant) {
		console.error(`Mandant '${slug}' nicht gefunden.`);
		process.exit(1);
	}

	await sql.begin(async (sql) => {
		// Alte Demo-Daten ersetzen; Betreiber/Vorstand samt Sessions bleiben.
		// Reihenfolge: Zaehlpunkte loeschen kaskadiert die Messungen, danach
		// sind die Kategorien loeschbar.
		await sql`delete from battery_site where tenant_id = ${tenant.id}`;
		await sql`delete from measurement_point where tenant_id = ${tenant.id}`;
		await sql`delete from meter_code where tenant_id = ${tenant.id}`;
		await sql`delete from weather where tenant_id = ${tenant.id}`;
		await sql`delete from member where tenant_id = ${tenant.id} and role = 'member'`;

		const members = [];
		for (const name of MEMBERS) {
			const [m] = await sql`
				insert into member (tenant_id, name, role) values (${tenant.id}, ${name}, 'member')
				returning id, name
			`;
			members.push(m);
		}

		const points = [];
		for (const [i, p] of POINTS.entries()) {
			const metering = `AT00300000000000000000000${String(100001 + i)}`;
			const [row] = await sql`
				insert into measurement_point (tenant_id, member_id, metering_point, direction, label)
				values (${tenant.id}, ${members[p.member].id}, ${metering}, ${p.direction},
					${p.direction === 'generation' ? `PV ${members[p.member].name}` : null})
				returning id
			`;
			points.push({ ...p, id: row.id, factor: rand() });
		}

		const codes = {};
		for (const c of METER_CODES) {
			const [row] = await sql`
				insert into meter_code (tenant_id, description, unit, kind)
				values (${tenant.id}, ${c.description}, ${'kWh'}, ${c.kind})
				returning id, kind
			`;
			codes[row.kind] = row.id;
		}

		// Taegliche Bewoelkung als Zufallspfad (1 = wolkenlos)
		const clearByDate = new Map();
		let clear = 0.7;
		const end = Math.floor(Date.now() / STEP) * STEP;
		const start = end - DAYS * 24 * 4 * STEP;
		for (let t = start; t <= end; t += STEP) {
			const { date } = localParts(t);
			if (!clearByDate.has(date)) {
				clear = Math.min(1, Math.max(0.15, clear + (rand() - 0.48) * 0.45));
				clearByDate.set(date, clear);
			}
		}

		// 15-Minuten-Reihen: je Intervall erst Gemeinschaftssummen, dann
		// Zuordnung nach EEG-Logik (Anteil proportional zum Verbrauch,
		// Eigendeckung = min(Verbrauch, Anteil), Rest ist Ueberschuss)
		const rows = [];
		const consPoints = points.filter((p) => p.direction === 'consumption');
		const genPoints = points.filter((p) => p.direction === 'generation');
		for (let t = start; t < end; t += STEP) {
			const { date, hour } = localParts(t);
			const clearSky = clearByDate.get(date);
			const measuredAt = new Date(t);

			const cons = consPoints.map((p) => {
				const kw = p.profile === 'business' ? businessKw(hour, rand()) : householdKw(hour, rand());
				return { p, kwh: (kw * (0.7 + 0.6 * p.factor)) / 4 };
			});
			const gen = genPoints.map((p) => {
				const kw = p.kwp * sunFactor(hour) * clearSky * (0.85 + 0.2 * rand());
				return { p, kwh: kw / 4 };
			});
			const totalCons = cons.reduce((s, x) => s + x.kwh, 0);
			const totalGen = gen.reduce((s, x) => s + x.kwh, 0);
			let selfSum = 0;
			for (const c of cons) {
				const share = totalCons > 0 ? (totalGen * c.kwh) / totalCons : 0;
				const self = Math.min(c.kwh, share);
				selfSum += self;
				rows.push(
					{ tenant_id: tenant.id, measurement_point_id: c.p.id, meter_code_id: codes.total_consumption, measured_at: measuredAt, value: round(c.kwh) },
					{ tenant_id: tenant.id, measurement_point_id: c.p.id, meter_code_id: codes.production_share, measured_at: measuredAt, value: round(share) },
					{ tenant_id: tenant.id, measurement_point_id: c.p.id, meter_code_id: codes.self_use, measured_at: measuredAt, value: round(self) }
				);
			}
			const overshootShare = totalGen > 0 ? 1 - selfSum / totalGen : 0;
			for (const g of gen) {
				rows.push(
					{ tenant_id: tenant.id, measurement_point_id: g.p.id, meter_code_id: codes.total_production, measured_at: measuredAt, value: round(g.kwh) },
					{ tenant_id: tenant.id, measurement_point_id: g.p.id, meter_code_id: codes.overshoot, measured_at: measuredAt, value: round(g.kwh * overshootShare) }
				);
			}
		}
		for (let i = 0; i < rows.length; i += 3000) {
			await sql`insert into measurement ${sql(rows.slice(i, i + 3000))}`;
		}

		// Stundenwetter passend zur Bewoelkung
		const weather = [];
		const hourStart = Math.ceil(start / 3600000) * 3600000;
		for (let t = hourStart; t < end; t += 3600000) {
			const { date, hour } = localParts(t);
			const clearSky = clearByDate.get(date) ?? 0.6;
			const sun = sunFactor(hour);
			const dayTemp = 14 + 11 * clearSky;
			const temp = dayTemp + 5 * Math.sin((Math.PI * (hour - 9)) / 12) + (rand() - 0.5);
			const cloud = Math.min(100, Math.max(0, (1 - clearSky) * 100 + (rand() - 0.5) * 15));
			const rain = clearSky < 0.35 && rand() < 0.4 ? round(rand() * 2.5, 1) : 0;
			weather.push({
				tenant_id: tenant.id,
				time: new Date(t),
				temperature_2m: round(temp, 1),
				cloud_cover: round(cloud, 1),
				rain,
				snowfall: 0,
				snow_depth: 0,
				cloud_cover_low: round(cloud * 0.5, 1),
				cloud_cover_mid: round(cloud * 0.3, 1),
				cloud_cover_high: round(cloud * 0.4, 1),
				relative_humidity_2m: round(55 + 30 * (1 - clearSky) + (rand() - 0.5) * 8, 1),
				dew_point_2m: round(temp - 4 - 4 * clearSky, 1),
				shortwave_radiation: round(870 * sun * (0.25 + 0.75 * clearSky), 1),
				direct_radiation: round(700 * sun * clearSky, 1),
				diffuse_radiation: round(170 * sun * (1 - 0.4 * clearSky), 1),
				direct_normal_irradiance: round(850 * sun * clearSky, 1),
				sunshine_duration: round(3600 * Math.min(1, Math.max(0, (clearSky - 0.3) * 1.6)) * (sun > 0.05 ? 1 : 0)),
				wind_speed_10m: round(4 + rand() * 14, 1),
				precipitation: rain,
				apparent_temperature: round(temp - 0.7, 1),
				snow_depth_water_equivalent: null
			});
		}
		for (let i = 0; i < weather.length; i += 1000) {
			await sql`insert into weather ${sql(weather.slice(i, i + 1000))}`;
		}

		// openHABian-Anlagen mit letztem Status-Push (Felder wie das Gateway
		// sie sendet, vgl. status_push.js in ISCHLSTROM)
		const now = Date.now();
		const { hour } = localParts(now);
		const clearToday = clearByDate.get(localParts(now).date) ?? 0.7;
		for (const s of SITES) {
			const token = randomBytes(24).toString('base64url');
			const hash = createHash('sha256').update(token).digest('hex');
			const pv = Math.round(s.pv_kwp * 1000 * sunFactor(hour) * clearToday);
			const load = Math.round(600 + rand() * 900);
			const status = {
				inverter_type: s.profile,
				inverter_status: s.minutesAgo < 10 ? 'running' : 'unknown',
				soc: s.soc,
				battery_power_w: s.battery_w,
				pv_power_w: pv,
				load_power_w: load,
				grid_power_w: load - pv - s.battery_w,
				hauptschalter: 'ON',
				ladesperre_aktiv: s.minutesAgo < 10 && clearToday > 0.6 ? 'ON' : 'OFF',
				batterie_kapazitaet: s.capacityKwh,
				min_battery_charge: 20,
				openhab_version: '4.3.3',
				openhabian_version: '1.9.1'
			};
			await sql`
				insert into battery_site (tenant_id, member_id, name, inverter_profile, token_hash, last_seen_at, status)
				values (${tenant.id}, ${members[s.member].id}, ${s.name}, ${s.profile}, ${hash},
					${new Date(now - s.minutesAgo * 60000)}, ${status})
			`;
			console.log(`Anlage '${s.name}' (${s.profile}), Gateway-Token: ${token}`);
		}

		console.log(`Demo-Daten fuer '${tenant.name}': ${members.length} Mitglieder, ${points.length} Zaehlpunkte, ${rows.length} Messwerte, ${weather.length} Wetterstunden, ${SITES.length} Anlagen.`);
	});
}

function round(x, digits = 4) {
	return Math.round(x * 10 ** digits) / 10 ** digits;
}

const [cmd, slugArg] = process.argv.slice(2);
try {
	if (cmd === 'seed') {
		await seed(slugArg ?? 'salzkammerstrom');
	} else {
		console.error('Verwendung: node scripts/demo-data.js seed [tenant-slug]');
		process.exit(cmd ? 1 : 0);
	}
} finally {
	await sql.end();
}
