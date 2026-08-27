// Anzeigehelfer fuer Anlagen, geteilt zwischen Dashboard-Karten und
// Detailansicht

/** @type {Record<string, string>} */
export const profileLabels = {
	'fronius-symo': 'Fronius Symo',
	'fronius-snapinverter': 'Fronius Snapinverter',
	sigenergy: 'Sigenergy',
	deye: 'Deye',
	victron: 'Victron'
};

export const de = (/** @type {number} */ x, digits = 1) =>
	x.toLocaleString('de-AT', { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Verbindungszustand fuer Badges und Karte: eine Anlage ohne ersten
// Status-Push ist nicht "Offline", sondern noch in Einrichtung.
export function connectionState(/** @type {any} */ site) {
	if (site.online) {
		return { label: 'Online', offline: false, dot: 'bg-green-500', text: 'text-green-600 dark:text-green-500', marker: '#16a34a' };
	}
	if (site.last_seen_at == null) {
		return { label: 'In Einrichtung', offline: false, dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500', marker: '#d97706' };
	}
	return { label: 'Offline', offline: true, dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500', marker: '#dc2626' };
}

export function seenLabel(/** @type {any} */ site) {
	if (site.seen_seconds_ago == null) return 'noch nie gemeldet';
	const min = Math.floor(site.seen_seconds_ago / 60);
	if (min < 1) return 'gerade eben';
	if (min < 60) return `vor ${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return `vor ${h} h`;
	return `vor ${Math.floor(h / 24)} Tagen`;
}

export function watt(/** @type {number | null | undefined} */ w) {
	if (typeof w !== 'number') return null;
	return Math.abs(w) >= 1000 ? `${de(Math.abs(w) / 1000)} kW` : `${Math.abs(Math.round(w))} W`;
}

// Vorzeichen wie vom Wechselrichter geliefert: Batterie + = Entladen,
// Netz + = Bezug, - = Einspeisung
export function batteryLabel(/** @type {any} */ s) {
	if (typeof s.battery_power_w !== 'number' || s.battery_power_w === 0) return 'Ruht';
	return `${s.battery_power_w > 0 ? 'Entlädt' : 'Lädt'} ${watt(s.battery_power_w)}`;
}

export function gridLabel(/** @type {any} */ s) {
	if (typeof s.grid_power_w !== 'number' || s.grid_power_w === 0) return 'Neutral';
	return `${s.grid_power_w > 0 ? 'Bezug' : 'Einspeisung'} ${watt(s.grid_power_w)}`;
}
