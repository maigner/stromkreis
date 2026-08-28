// Einrichtung eines Gateways (openHABian auf Raspberry Pi) nach dem ISCHLSTROM-Modell
// (Energiegemeinschaft/website/src/lib/server/db/members/openhabProvision.js):
// Die Plattform vergibt je Anlage einen Einrichtungscode XXXX-XXXX (60 Tage) und
// einen Anlagen-Token (nur Hash gespeichert). Stromkreis gibt ausschliesslich fertige
// SD-Karten-Images aus (openHABian plus openhabian.conf mit Hostname, Benutzer, WLAN,
// Zeitzone, stromkreis-provision.conf mit Code + Plattform-URL und user-data mit dem
// Firstboot-Autostart; gebaut von gateway-image.js). Das Gateway holt beim ersten Start per
// POST /api/gateway/provision/v1 {code} seine Konfiguration samt Token und meldet
// den Fortschritt per POST /api/gateway/provision/v1/result. Kein Token, kein
// Passwort auf der Karte; der Code bleibt bis "fertig" oder Ablauf gueltig,
// damit ein Neustart die Einrichtung wiederholen kann.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { env } from '$env/dynamic/public';
import { sql } from './db.js';
import firstbootScript from './gateway-firstboot/stromkreis-firstboot.sh?raw';
import firstbootService from './gateway-firstboot/stromkreis-firstboot.service?raw';

export const PROVISION_CODE_DAYS = 60;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1

/** Phasen der Einrichtung, wie sie das Gateway meldet (Untermenge von ISCHLSTROM setupPhases.js). */
export const SETUP_PHASES = /** @type {Record<string, { label: string, percent: number }>} */ ({
	neu: { label: 'SD-Karte noch nicht gestartet', percent: 0 },
	konfiguration: { label: 'Konfiguration geladen', percent: 10 },
	wechselrichter_suche: { label: 'Wechselrichter wird gesucht', percent: 15 },
	wechselrichter_unklar: { label: 'Wechselrichter nicht eindeutig, bitte Profil setzen', percent: 15 },
	passwoerter: { label: 'Passwörter', percent: 30 },
	addons: { label: 'openHAB-Erweiterungen', percent: 45 },
	wechselrichter: { label: 'Wechselrichter wird eingebunden', percent: 60 },
	wartet_auf_passwort: { label: 'Wartet auf das Passwort des Wechselrichters', percent: 60 },
	wartet_auf_wechselrichter: { label: 'Wartet auf den Wechselrichter im Netz', percent: 60 },
	items: { label: 'Datenpunkte', percent: 70 },
	regeln: { label: 'Steuerung', percent: 80 },
	overview: { label: 'Oberfläche', percent: 90 },
	updater: { label: 'Selbst-Update wird eingerichtet', percent: 92 },
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

/**
 * Inhalt der user-data fuer die Boot-Partition (ersetzt die Vorlage des
 * openHABian-Images): cloud-init (im Raspberry-Pi-OS-Image enthalten,
 * NoCloud-Datasource liest die Boot-Partition) installiert damit beim ersten
 * Boot die systemd-Unit stromkreis-firstboot; sie wartet die
 * openHABian-Erstinstallation ab und startet dann die Einrichtung mit dem
 * Code aus stromkreis-provision.conf. Inhalt ist fuer alle Anlagen gleich;
 * die Anlage steckt in stromkreis-provision.conf.
 */
export function renderUserData() {
	// YAML-Block-Scalar: jede Zeile 6 Stellen einruecken, Leerzeilen bleiben leer
	const block = (/** @type {string} */ text) =>
		text
			.replace(/\n$/, '')
			.split('\n')
			.map((line) => (line ? '      ' + line : ''))
			.join('\n');
	return `#cloud-config
# Stromkreis - Zero-Touch-Autostart der Gateway-Einrichtung.
# cloud-init installiert beim ersten Boot die systemd-Unit stromkreis-firstboot;
# sie wartet, bis openHABian fertig installiert ist, und richtet dann das
# Batteriemanagement mit dem Code aus stromkreis-provision.conf ein.
write_files:
  - path: /usr/local/sbin/stromkreis-firstboot
    permissions: '0755'
    content: |
${block(firstbootScript)}
  - path: /etc/systemd/system/stromkreis-firstboot.service
    permissions: '0644'
    content: |
${block(firstbootService)}
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, stromkreis-firstboot.service]
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
		returning b.id, b.tenant_id, b.name, b.inverter_profile, b.status, b.capacity_kwh, b.pv_kwp, t.slug as tenant_slug, t.name as tenant_name,
			(select m.name from member m where m.tenant_id = b.tenant_id and m.id = b.member_id) as member_name`;
	if (!site) return null;
	// openHAB-Admin-Konto: gleiches Passwort wie der Linux-Benutzer (steht in
	// der openhabian.conf des Images und in der Anlagen-Detailansicht).
	// Aeltere Anlagen ohne linux_password bekommen hier eines.
	let linuxPassword = site.status?.linux_password;
	if (!linuxPassword) {
		linuxPassword = randomPassword();
		await sql`
			update battery_site set status = status || ${sql.json({ linux_password: linuxPassword })}
			where tenant_id = ${site.tenant_id} and id = ${site.id}`;
	}
	const firstname = typeof site.member_name === 'string' ? site.member_name.trim().split(/\s+/)[0] : '';
	return {
		site,
		config: {
			STROMKREIS_BASE_URL: platformBaseUrl(),
			STROMKREIS_SITE_TOKEN: token,
			STROMKREIS_SITE_ID: String(site.id),
			STROMKREIS_ANLAGE_NAME: site.name,
			STROMKREIS_TENANT: site.tenant_slug,
			STROMKREIS_VORNAME: firstname,
			INVERTER_PROFILE: site.inverter_profile,
			BATTERIE_KAPAZITAET_KWH: site.capacity_kwh == null ? '' : String(site.capacity_kwh),
			PV_KWP: site.pv_kwp == null ? '' : String(site.pv_kwp),
			MIN_BATTERY_CHARGE: String(site.status?.min_battery_charge ?? 20),
			DEFAULT_MAIN_SWITCH: 'ON',
			STATUS_INTERVAL_S: '300',
			OH_ADMIN_USER: 'admin',
			OH_ADMIN_PASSWORD: linuxPassword
		}
	};
}
