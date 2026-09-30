// ============================================================================
// Stromkreis Demo-openHAB (App-Pruefung): Simulation eines Tages im Minutentakt.
// Ersetzt Wechselrichter und Steuerung durch einen festen, plausiblen
// Tagesverlauf (Europe/Vienna): nachts forcierte Entladung ins Netz, am
// Vormittag Ladesperre, dann geregeltes Laden bis 15:30, am Abend Haushalt
// aus der Batterie. Schalter auf den Seiten bleiben bedienbar; steht das
// Speichermanagement aus (Hauptschalter AUS oder Pause), verhaelt sich
// die Batterie "wie ab Werk" (nur Haushalt, keine Einspeisung).
// Datei-basierte Regel, JS Scripting (openhab-js wird automatisch injiziert).
// ============================================================================

const CAPACITY_KWH = 10.2;
const PV_KWP = 8.4;
const CLEAR_SKY = 0.85;

// Feste Zeiten der Gemeinschaft, wie sie die Plattform liefern wuerde
const TIMES = {
	crossoverStart: '19:45',
	crossoverEnde: '08:30',
	crossoverVormittag: '09:40',
	entladestart: '21:00',
	entladeende: '05:30',
	ladesperreStart: '06:30',
	ladesperreEnde: '09:40'
};

// Einstellungen, die das Mitglied setzen koennte: nur belegen, wenn NULL
const DEFAULTS = {
	Stromkreis_Aktiv: 'ON',
	Stromkreis_LADESPERRE_AKTIV: 'ON',
	Stromkreis_ENTLADUNG_AKTIV: 'ON',
	Stromkreis_MIN_BATTERY_CHARGE: 20,
	Minimale_Entladeleistung_Batterieeinspeisung: 300,
	Maximale_Entladeleistung_Batterieeinspeisung: 2000,
	Stromkreis_PAUSE_TAGE: 0,
	Stromkreis_LADESPERRE_WOLKEN_SCHWELLE: 40,
	Stromkreis_DYNAMISCHE_LEISTUNG: 'ON',
	Stromkreis_BATTERIE_KAPAZITAET: CAPACITY_KWH,
	Stromkreis_LADESPERRE_LOKAL: 'ON',
	Stromkreis_LADELEISTUNG: 3.4,
	Stromkreis_LADEREGELUNG: 'ON',
	Stromkreis_NETZLADESCHUTZ: 'ON',
	Stromkreis_Ladesperre_Individuell: 'ON',
	Stromkreis_Wolkenvorschau: 25,
	Stromkreis_Ertragsprognose: 85,
	Stromkreis_HAUSLAST: 480,
	Stromkreis_NACHTBUDGET: 4.8,
	Stromkreis_NETZLADUNG: 0
};

function post(name, value) {
	const item = items.getItem(name, true);
	if (item) item.postUpdate(String(value));
}

function stateOf(name) {
	const item = items.getItem(name, true);
	if (!item) return null;
	const s = item.state;
	return s === null || s === 'NULL' || s === 'UNDEF' ? null : s;
}

function sunFactor(hour) {
	if (hour < 6.2 || hour > 20.7) return 0;
	return Math.pow(Math.sin((Math.PI * (hour - 6.2)) / 14.5), 1.35);
}

function gauss(x, mu, sigma) {
	return Math.exp(-Math.pow((x - mu) / sigma, 2));
}

// Ladestand in Prozent und dessen Aenderung (%/h) zu einer Tagesstunde,
// bei aktivem Speichermanagement
function socManaged(h) {
	const seg = [
		[0, 2, 59, 30],      // Rest der Nacht-Einspeisung (21:00 -> 02:00: 78 -> 30)
		[2, 6.5, 30, 24],    // Haushalt aus der Batterie
		[6.5, 9.7, 24, 30],  // Ladesperre: nur Ueberschuss ueber Hausverbrauch
		[9.7, 15.5, 30, 100], // geregeltes Laden bis 15:30
		[15.5, 21, 100, 78], // Abend: Haushalt aus der Batterie
		[21, 24, 78, 59]     // forcierte Entladung ins Netz
	];
	for (const [a, b, s0, s1] of seg) {
		if (h >= a && h < b) {
			const rate = (s1 - s0) / (b - a);
			return { soc: s0 + rate * (h - a), rate };
		}
	}
	return { soc: 59, rate: 0 };
}

// "Wie ab Werk": laden sobald Ueberschuss, Haushalt bis Ladestand-Minimum
function socFactory(h) {
	const seg = [
		[0, 7, 52, 20],
		[7, 13, 20, 100],
		[13, 17.5, 100, 100],
		[17.5, 24, 100, 52]
	];
	for (const [a, b, s0, s1] of seg) {
		if (h >= a && h < b) {
			const rate = (s1 - s0) / (b - a);
			return { soc: s0 + rate * (h - a), rate };
		}
	}
	return { soc: 52, rate: 0 };
}

function fmtKw(w) {
	return (Math.round(w / 100) / 10).toFixed(1).replace('.', ',') + ' kW';
}

function tick() {
	for (const [name, value] of Object.entries(DEFAULTS)) {
		if (stateOf(name) === null) post(name, value);
	}

	const now = time.ZonedDateTime.now();
	const h = now.hour() + now.minute() / 60;
	const noise = Math.sin(now.minute() * 1.7) * 0.5 + Math.sin(now.minute() * 0.37) * 0.5; // -1..1, ruhig
	const aktiv = stateOf('Stromkreis_Aktiv') === 'ON' && Number(stateOf('Stromkreis_PAUSE_TAGE') || 0) <= 0;
	const entladung = aktiv && stateOf('Stromkreis_ENTLADUNG_AKTIV') === 'ON';

	const pv = Math.round(PV_KWP * 1000 * sunFactor(h) * CLEAR_SKY * (1 + noise * 0.06));
	const load = Math.round(420 + 550 * gauss(h, 7.4, 1.1) + 800 * gauss(h, 19.2, 1.7) + noise * 70);

	const { soc, rate } = aktiv ? socManaged(h) : socFactory(h);
	// Fronius-Vorzeichen: negativ = Batterie laedt, positiv = Batterie entlaedt
	let battery = Math.round(-rate * CAPACITY_KWH * 10);
	if (!entladung && battery > load) battery = load; // ohne Einspeisung nur der Haushalt
	const grid = load - pv - battery; // positiv = Bezug, negativ = Einspeisung
	const einspeisungBatterie = battery > 0 && grid < 0 ? Math.min(battery, -grid) : 0;

	post('Fronius_Symo_Inverter_Battery_State_of_Charge', Math.round(soc * 10) / 10);
	post('Fronius_Symo_Inverter_Battery_Power', battery);
	post('Fronius_Symo_Inverter_Grid_Power', grid);
	post('Fronius_Symo_Inverter_Solar_Plant_Power', pv);
	post('Stromkreis_BATTERIE_NETZEINSPEISUNG', einspeisungBatterie);

	// Einspeise-Zaehler: laufender Tag plus Vortage (2,3 kWh je Nacht)
	const dayKwh = h < 5.5 ? 1.9 * (h / 5.5) : h >= 21 ? 1.9 + 0.4 * ((h - 21) / 3) : 1.9;
	const dayOfYear = now.dayOfYear();
	const weekday = now.dayOfWeek().value(); // 1 = Montag
	post('Stromkreis_BATTERIE_NETZEINSPEISUNG_KWH', (312.4 + (dayOfYear - 1) * 2.3 + dayKwh).toFixed(2));
	post('Stromkreis_BATTERIE_NETZEINSPEISUNG_WOCHE_KWH', ((weekday - 1) * 2.3 + dayKwh).toFixed(2));
	post('Stromkreis_BATTERIE_NETZEINSPEISUNG_MONAT_KWH', ((now.dayOfMonth() - 1) * 2.3 + dayKwh).toFixed(2));

	// Zeiten und Prognosen "von der Plattform"
	const today = now.format(time.DateTimeFormatter.ofPattern('yyyy-MM-dd'));
	const stamp = now.format(time.DateTimeFormatter.ofPattern('yyyy-MM-dd HH:mm'));
	post('Stromkreis_Crossover_Start', TIMES.crossoverStart);
	post('Stromkreis_Crossover_Ende', TIMES.crossoverEnde);
	post('Stromkreis_Crossover_Vormittag', TIMES.crossoverVormittag);
	post('Stromkreis_Crossover_Zeit', stamp);
	post('Stromkreis_Entladestart', TIMES.entladestart);
	post('Stromkreis_Entladeende', TIMES.entladeende);
	post('Stromkreis_Ladesperre_Start', TIMES.ladesperreStart);
	post('Stromkreis_Ladesperre_Ende', TIMES.ladesperreEnde);
	post('Stromkreis_Ladesperre_Datum', today);
	post('Stromkreis_LADESPERRE_LOKAL_ENDE', TIMES.ladesperreEnde);
	post('Stromkreis_Wolkenvorschau_Zeit', stamp);

	const laden = aktiv && h >= 9.7 && h < 15.5;
	post('Stromkreis_LADEREGELUNG_SOLL', laden ? fmtKw(-battery) : '-');
	if (h < 15.5 && aktiv) {
		const restMin = Math.max(0, Math.round((15.5 - Math.max(h, 9.7)) * 60 * 0.8));
		post('Stromkreis_RESTLADEZEIT', Math.floor(restMin / 60) + ' h ' + (restMin % 60) + ' min');
	} else {
		post('Stromkreis_RESTLADEZEIT', '-');
	}
}

rules.when().cron('0 * * * * ?').then(tick).build('Stromkreis Demo-Simulation', 'Schreibt jede Minute den simulierten Anlagenzustand');

// Sofort beim Laden der Datei, damit die Seiten nicht bis zur naechsten
// vollen Minute leer bleiben (Items koennten noch fehlen: dann naechster Tick).
try {
	tick();
} catch (e) {
	console.warn('Stromkreis Demo: erster Tick uebersprungen: ' + e);
}
