#!/usr/bin/env node
// Demo-Datengenerator fuer den Demo-Mandanten (Salzkammerstrom): erfundene,
// aber plausible Daten fuer Dashboards und Vorfuehrung. Erzeugt Mitglieder,
// Zaehlpunkte, EEG-Faktura-Kategorien, 15-Minuten-Reihen (35 Tage), Stunden-
// wetter und openHABian-Anlagen mit Status. Deterministisch (fester Seed),
// erneutes Ausfuehren ersetzt die Demo-Daten vollstaendig; Betreiber- und
// Vorstandskonten bleiben erhalten.
// 'heartbeat' simuliert die regelmaessigen Status-Pushes der Gateways, damit
// die Online-Anzeige (10-Minuten-Fenster) nicht nach dem Seed altert; laeuft
// am Server als Compose-Dienst alle 5 Minuten.
// Aufruf: node scripts/demo-data.js seed|heartbeat [tenant-slug]   (Default: salzkammerstrom)
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

// Zeitstempel im openhab.log-Format (lokale Zeit Europe/Vienna)
const logTsFmt = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Vienna',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23'
});
function logTs(ms) {
	const p = Object.fromEntries(logTsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${millis}`;
}

// Juengste openhab.log-Zeilen, wie sie das Gateway mit dem Status-Push
// mitschickt (Framework-Events englisch, eigene Regel-Logs deutsch/ASCII)
function makeLogs(s, endMs) {
	const times = [];
	let t = endMs - Math.floor(rand() * 20000);
	for (let i = 0; i < 30; i++) {
		times.push(t);
		t -= Math.floor((20 + rand() * 160) * 1000);
	}
	times.reverse();
	let soc = Math.max(5, s.soc - 4);
	let pv = Math.round(s.pv_kwp * 1000 * (0.25 + rand() * 0.3));
	const lines = [];
	for (const ms of times) {
		const r = rand();
		let level = 'INFO';
		let logger;
		let msg;
		if (r < 0.26) {
			const from = soc;
			soc = Math.min(100, soc + (rand() < 0.75 ? 1 : 0));
			logger = 'openhab.event.ItemStateChangedEvent';
			msg = `Item 'Batterie_SOC' changed from ${from} to ${soc}`;
		} else if (r < 0.48) {
			const from = pv;
			pv = Math.max(0, pv + Math.round((rand() - 0.5) * 400));
			logger = 'openhab.event.ItemStateChangedEvent';
			msg = `Item 'PV_Leistung' changed from ${from} to ${pv}`;
		} else if (r < 0.62) {
			logger = 'org.openhab.core.model.script.stromkreis';
			msg = 'Status-Push an stromkreis.net gesendet (HTTP 200)';
		} else if (r < 0.76) {
			logger = 'org.openhab.core.model.script.ladesperre';
			msg = `Pruefung Ladesperre: SoC ${soc}%, PV ${pv} W`;
		} else if (r < 0.92) {
			const from = Math.round((rand() - 0.5) * 3000);
			logger = 'openhab.event.ItemStateChangedEvent';
			msg = `Item 'Netz_Leistung' changed from ${from} to ${Math.round(from + (rand() - 0.5) * 600)}`;
		} else {
			level = 'WARN';
			logger = 'org.openhab.core.io.transport.modbus';
			msg = 'Try 1 out of 3 failed when executing request. Will try again soon.';
		}
		lines.push({ ts: logTs(ms), level, logger, msg });
	}
	return lines;
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

// Standorte im Salzkammergut: echte Ortskoordinaten, erfundene Adressen
const SITES = [
	{
		name: 'Anlage Bad Ischl', profile: 'fronius-symo', member: 1, capacityKwh: 11, minutesAgo: 2,
		soc: 76, battery_w: -1450, pv_kwp: 18, lat: 47.7106, lon: 13.6244,
		address: 'Kaltenbachstraße 14, 4820 Bad Ischl'
	},
	{
		name: 'Anlage Bad Goisern', profile: 'sigenergy', member: 6, capacityKwh: 16, minutesAgo: 1,
		soc: 64, battery_w: -2100, pv_kwp: 30, lat: 47.6435, lon: 13.619,
		address: 'Untere Marktstraße 8, 4822 Bad Goisern'
	},
	{
		name: 'Anlage Ebensee', profile: 'victron', member: 4, capacityKwh: 7.7, minutesAgo: 187,
		soc: 41, battery_w: 380, pv_kwp: 0, lat: 47.8076, lon: 13.7772,
		address: 'Traunkai 5, 4802 Ebensee'
	},
	{
		name: 'Anlage Gmunden', profile: 'deye', member: 0, capacityKwh: 10, minutesAgo: 4,
		soc: 58, battery_w: -900, pv_kwp: 8, lat: 47.9184, lon: 13.7995,
		address: 'Seeuferstraße 21, 4810 Gmunden'
	},
	{
		name: 'Anlage Altmünster', profile: 'fronius-symo', member: 2, capacityKwh: 8.8, minutesAgo: 3,
		soc: 82, battery_w: -600, pv_kwp: 10, lat: 47.9022, lon: 13.7634,
		address: 'Maisdorfer Weg 3, 4813 Altmünster'
	},
	{
		name: 'Anlage Traunkirchen', profile: 'sigenergy', member: 3, capacityKwh: 12.5, minutesAgo: 6,
		soc: 47, battery_w: -1800, pv_kwp: 14, lat: 47.8449, lon: 13.7873,
		address: 'Klosterweg 2, 4801 Traunkirchen'
	},
	{
		name: 'Anlage St. Wolfgang', profile: 'victron', member: 5, capacityKwh: 5.1, minutesAgo: 2,
		soc: 91, battery_w: 0, pv_kwp: 6, lat: 47.7405, lon: 13.4464,
		address: 'Pilgerweg 17, 5360 St. Wolfgang'
	},
	{
		name: 'Anlage Strobl', profile: 'deye', member: 7, capacityKwh: 15, minutesAgo: 8,
		soc: 22, battery_w: -2600, pv_kwp: 20, lat: 47.7172, lon: 13.4863,
		address: 'Bürglsteinstraße 9, 5350 Strobl'
	},
	{
		name: 'Anlage Mondsee', profile: 'fronius-symo', member: 8, capacityKwh: 9.6, minutesAgo: 5,
		soc: 69, battery_w: 250, pv_kwp: 7, lat: 47.856, lon: 13.348,
		address: 'Herzog-Odilo-Straße 30, 5310 Mondsee'
	},
	{
		name: 'Anlage Obertraun', profile: 'sigenergy', member: 9, capacityKwh: 24, minutesAgo: 1,
		soc: 55, battery_w: -3400, pv_kwp: 12, lat: 47.559, lon: 13.689,
		address: 'Höhlenweg 4, 4831 Obertraun'
	},
	{
		name: 'Anlage Hallstatt', profile: 'fronius-symo', member: 0, capacityKwh: 6.5, minutesAgo: 3,
		soc: 73, battery_w: -750, pv_kwp: 5, lat: 47.5622, lon: 13.6493,
		address: 'Salzbergstraße 6, 4830 Hallstatt'
	},
	{
		name: 'Anlage Gosau', profile: 'deye', member: 2, capacityKwh: 12, minutesAgo: 42,
		soc: 38, battery_w: 620, pv_kwp: 9, lat: 47.585, lon: 13.536,
		address: 'Gosauseestraße 11, 4824 Gosau'
	},
	{
		name: 'Anlage St. Gilgen', profile: 'sigenergy', member: 4, capacityKwh: 14, minutesAgo: 2,
		soc: 67, battery_w: -1600, pv_kwp: 16, lat: 47.7666, lon: 13.3653,
		address: 'Mozartplatz 3, 5340 St. Gilgen'
	},
	{
		name: 'Anlage Fuschl am See', profile: 'victron', member: 6, capacityKwh: 9.2, minutesAgo: 6,
		soc: 84, battery_w: -400, pv_kwp: 8, lat: 47.7997, lon: 13.3038,
		address: 'Seepromenade 8, 5330 Fuschl am See'
	},
	{
		name: 'Anlage Unterach', profile: 'fronius-symo', member: 8, capacityKwh: 11, minutesAgo: 4,
		soc: 61, battery_w: -1100, pv_kwp: 12, lat: 47.808, lon: 13.488,
		address: 'Atterseestraße 19, 4866 Unterach am Attersee'
	},
	{
		name: 'Anlage Steinbach', profile: 'deye', member: 5, capacityKwh: 8, minutesAgo: 7,
		soc: 79, battery_w: -500, pv_kwp: 7, lat: 47.828, lon: 13.532,
		address: 'Forstamtstraße 2, 4853 Steinbach am Attersee'
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
				openhabian_version: '1.9.1',
				logs: makeLogs(s, now - s.minutesAgo * 60000)
			};
			await sql`
				insert into battery_site (tenant_id, member_id, name, inverter_profile, token_hash, last_seen_at, status, latitude, longitude, address)
				values (${tenant.id}, ${members[s.member].id}, ${s.name}, ${s.profile}, ${hash},
					${new Date(now - s.minutesAgo * 60000)}, ${status}, ${s.lat}, ${s.lon}, ${s.address})
			`;
			console.log(`Anlage '${s.name}' (${s.profile}), Gateway-Token: ${token}`);
		}

		console.log(`Demo-Daten fuer '${tenant.name}': ${members.length} Mitglieder, ${points.length} Zaehlpunkte, ${rows.length} Messwerte, ${weather.length} Wetterstunden, ${SITES.length} Anlagen.`);
	});
}

// Frischer Status-Push fuer die Online-Anlagen; die Offline-Anlagen bleiben
// auf festem Alter stehen (Status-Push bleibt dort absichtlich veraltet).
async function heartbeat(slug) {
	const [tenant] = await sql`select id, name from tenant where slug = ${slug}`;
	if (!tenant) {
		console.error(`Mandant '${slug}' nicht gefunden.`);
		process.exit(1);
	}
	const now = Date.now();
	const { hour } = localParts(now);
	const clearSky = 0.7;
	let updated = 0;
	for (const s of SITES) {
		const online = s.minutesAgo < 10;
		const lastSeen = online
			? new Date(now - Math.floor(Math.random() * 4 * 60000))
			: new Date(now - s.minutesAgo * 60000);
		let res;
		if (online) {
			const pv = Math.round(s.pv_kwp * 1000 * sunFactor(hour) * clearSky);
			const load = Math.round(600 + Math.random() * 900);
			const patch = {
				inverter_status: 'running',
				pv_power_w: pv,
				load_power_w: load,
				grid_power_w: load - pv - s.battery_w,
				logs: makeLogs(s, lastSeen.getTime())
			};
			res = await sql`
				update battery_site
				set last_seen_at = ${lastSeen}, status = status || ${sql.json(patch)}
				where tenant_id = ${tenant.id} and name = ${s.name}
			`;
		} else {
			res = await sql`
				update battery_site set last_seen_at = ${lastSeen}
				where tenant_id = ${tenant.id} and name = ${s.name}
			`;
		}
		updated += res.count;
	}
	console.log(`Heartbeat: ${updated} Anlagen aktualisiert.`);
}

function round(x, digits = 4) {
	return Math.round(x * 10 ** digits) / 10 ** digits;
}

const [cmd, slugArg] = process.argv.slice(2);
try {
	if (cmd === 'seed') {
		await seed(slugArg ?? 'salzkammerstrom');
	} else if (cmd === 'heartbeat') {
		await heartbeat(slugArg ?? 'salzkammerstrom');
	} else {
		console.error('Verwendung: node scripts/demo-data.js seed|heartbeat [tenant-slug]');
		process.exit(cmd ? 1 : 0);
	}
} finally {
	await sql.end();
}
