// Einrichtung eines Gateways (openHABian auf Raspberry Pi) nach dem ISCHLSTROM-Modell
// (Energiegemeinschaft/website/src/lib/server/db/members/openhabProvision.js):
// Die Plattform vergibt je Anlage einen Einrichtungscode XXXX-XXXX (60 Tage) und
// einen Anlagen-Token (nur Hash gespeichert). Stromkreis gibt ausschliesslich fertige
// SD-Karten-Images aus (openHABian plus openhabian.conf mit Hostname, Benutzer, WLAN,
// Zeitzone und stromkreis-provision.conf mit Code + Plattform-URL; Image-Builder folgt,
// die Renderer unten liefern die Dateien dafuer). Das Gateway holt beim ersten Start per
// POST /api/gateway/provision/v1 {code} seine Konfiguration samt Token und meldet
// den Fortschritt per POST /api/gateway/provision/v1/result. Kein Token, kein
// Passwort auf der Karte; der Code bleibt bis "fertig" oder Ablauf gueltig,
// damit ein Neustart die Einrichtung wiederholen kann.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { env } from '$env/dynamic/public';
import { sql } from './db.js';

export const PROVISION_CODE_DAYS = 60;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1

/** Phasen der Einrichtung, wie sie das Gateway meldet (Untermenge von ISCHLSTROM setupPhases.js). */
export const SETUP_PHASES = /** @type {Record<string, { label: string, percent: number }>} */ ({
	neu: { label: 'SD-Karte noch nicht gestartet', percent: 0 },
	konfiguration: { label: 'Konfiguration geladen', percent: 10 },
	wechselrichter_suche: { label: 'Wechselrichter wird gesucht', percent: 15 },
	wechselrichter_unklar: { label: 'Wechselrichter nicht eindeutig, bitte Profil setzen', percent: 15 },
	tunnel: { label: 'Fernwartung', percent: 25 },
	passwoerter: { label: 'Passwörter', percent: 30 },
	addons: { label: 'openHAB-Erweiterungen', percent: 45 },
	wechselrichter: { label: 'Wechselrichter wird eingebunden', percent: 60 },
	items: { label: 'Datenpunkte', percent: 70 },
	regeln: { label: 'Steuerung', percent: 80 },
	overview: { label: 'Oberfläche', percent: 90 },
	unvollstaendig: { label: 'Wartet, wird automatisch fortgesetzt', percent: 95 },
	fertig: { label: 'Einrichtung abgeschlossen', percent: 100 }
});

/** @param {string} phase */
export function describePhase(phase) {
	if (SETUP_PHASES[phase]) return SETUP_PHASES[phase];
	if (phase.startsWith('fehler:')) return { label: `Fehler bei Schritt ${phase.slice(7)}`, percent: 0 };
	return { label: phase, percent: 0 };
}

export function newProvisionCode() {
	const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
	return `${part()}-${part()}`;
}

export function newSiteToken() {
	const token = randomBytes(24).toString('base64url');
	return { token, hash: createHash('sha256').update(token).digest('hex') };
}

/** @param {string} pw */
function shellQuote(pw) {
	return `"${pw.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function randomPassword(length = 14) {
	const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/**
 * @param {{ hostname: string, userPassword: string, wifiSsid?: string | null, wifiPassword?: string | null }} p
 */
export function renderOpenhabianConf(p) {
	const lines = [
		'# openHABian-Konfiguration, erzeugt von Stromkreis fuer diese Anlage.',
		'# Wird beim ersten Start von openHABian gelesen (Datei liegt auf der Boot-Partition).',
		`hostname=${p.hostname}`,
		'username=openhabian',
		`userpw=${shellQuote(p.userPassword)}`,
		'timezone=Europe/Vienna',
		'locales=de_AT.UTF-8 en_US.UTF-8',
		'system_default_locale=de_AT.UTF-8',
		'wifi_country=AT',
		'debugmode=off',
		'clonebranch=openHAB',
		'zram_reset=done',
		'srv_mount_fix=done'
	];
	if (p.wifiSsid) {
		lines.push(`wifi_ssid=${shellQuote(p.wifiSsid)}`, `wifi_password=${shellQuote(p.wifiPassword || '')}`);
	}
	return lines.join('\n') + '\n';
}

/** @param {{ code: string, baseUrl: string }} p */
export function renderProvisionConf(p) {
	return [
		'# Stromkreis-Einrichtung: Code und Plattform-URL. Kein Geheimnis auf der Karte;',
		'# das Gateway holt seine Konfiguration beim ersten Start von der Plattform.',
		`STROMKREIS_PROVISION_CODE=${p.code}`,
		`STROMKREIS_BASE_URL=${p.baseUrl}`
	].join('\n') + '\n';
}

/** @param {{ name: string, code: string, expires: Date, tenantName: string }} p */
export function renderReadme(p) {
	return `Stromkreis: SD-Karte fuer Anlage ${p.name} (${p.tenantName})
================================================================

1. openHABian mit dem Raspberry Pi Imager auf die SD-Karte schreiben
   (Other specific-purpose OS > Home assistants > openHABian, 64-bit).
2. Nach dem Schreiben die Boot-Partition der Karte oeffnen und die beiden
   Dateien openhabian.conf und stromkreis-provision.conf aus diesem Zip
   dorthin kopieren (openhabian.conf ueberschreiben).
3. Karte in den Raspberry Pi, Netzwerk (LAN oder das eingetragene WLAN)
   und Strom anstecken. Die Einrichtung dauert 30 bis 45 Minuten und
   erscheint im Stromkreis-Dashboard unter der Anlage als Fortschritt.

Einrichtungscode: ${p.code} (gueltig bis ${p.expires.toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })})
Der Code ist kein Passwort; er kann nach Ablauf im Dashboard erneuert werden.
`;
}

export function platformBaseUrl() {
	return (env.PUBLIC_ORIGIN || 'https://stromkreis.net').replace(/\/$/, '');
}

/**
 * Einrichtungscode einloesen (Gateway-Erstkontakt). Liefert die Konfiguration
 * oder null. Der Code bleibt gueltig bis fertig/Ablauf; der Token wird bei jedem
 * Abruf neu erzeugt (nur Hash gespeichert), damit die Karte nie einen Token traegt.
 * @param {string} code
 */
export async function consumeProvisionCode(code) {
	const normalized = code.trim().toUpperCase();
	if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) return null;
	const { token, hash } = newSiteToken();
	const [site] = await sql`
		update battery_site b set token_hash = ${hash}, provisioned_at = now(),
			setup_phase = case when b.setup_phase = 'neu' then 'konfiguration' else b.setup_phase end,
			setup_phase_at = now()
		from tenant t
		where b.tenant_id = t.id and b.provision_code = ${normalized}
			and b.provision_expires_at > now() and b.setup_phase <> 'fertig'
		returning b.id, b.tenant_id, b.name, b.inverter_profile, b.status, b.capacity_kwh, b.pv_kwp, t.slug as tenant_slug, t.name as tenant_name`;
	if (!site) return null;
	return {
		site,
		config: {
			STROMKREIS_BASE_URL: platformBaseUrl(),
			STROMKREIS_SITE_TOKEN: token,
			STROMKREIS_SITE_ID: String(site.id),
			STROMKREIS_ANLAGE_NAME: site.name,
			STROMKREIS_TENANT: site.tenant_slug,
			INVERTER_PROFILE: site.inverter_profile,
			BATTERIE_KAPAZITAET_KWH: site.capacity_kwh == null ? '' : String(site.capacity_kwh),
			PV_KWP: site.pv_kwp == null ? '' : String(site.pv_kwp),
			MIN_BATTERY_CHARGE: String(site.status?.min_battery_charge ?? 20),
			DEFAULT_MAIN_SWITCH: 'ON',
			STATUS_INTERVAL_S: '300'
		}
	};
}
