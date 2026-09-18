// ============================================================================
// Fernwartung der Gateways: feste Wartungsaktionen per SSH, aus der
// Anlagen-Detailseite heraus (Tab "Fernwartung").
//
// Weg: Browser (Knopf, schickt nur die Kennung der Aktion) -> Plattform ->
// ssh2-Client -> SOCKS5-Durchgang im WireGuard-Container (microsocks, nur im
// Compose-Netz erreichbar) -> Wartungsnetz wg0 -> Pi.
//
// Bewusst keine freie Konsole mehr: welche Befehle am Pi laufen, steht
// ausschliesslich in der Liste ACTIONS unten; vom Browser kommt nie
// Befehlstext. Wer wirklich eine Shell braucht: deploy/wg-ssh.sh am Server.
//
// Die Anmeldung am Pi ist normales SSH mit Passwort (openhabian + Anlagen-
// Passwort aus status.linux_password); der Browser bekommt das Passwort nie
// zu sehen. Ohne Host-Key-Pruefung (wie accept-new bei wg-ssh.sh): die
// Gegenstellen wechseln mit jeder Neuinstallation, das Wartungsnetz ist
// nur ueber den Tunnel erreichbar - dokumentiertes Restrisiko.
// ============================================================================
import { connect as netConnect } from 'node:net';
import { Client } from 'ssh2';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db.js';

const OUTPUT_BYTES = 64 * 1024; // je Aktion behaltene Ausgabe (das Ende zaehlt)
const SETUP_DIR = '/opt/stromkreis/openhab/setup'; // Ziel von static/gateway/install.sh

/**
 * @typedef {Object} RemoteAction
 * @property {string} id
 * @property {'aktion' | 'abfrage'} kind aktion greift ein, abfrage liest nur
 * @property {string} label
 * @property {string} description
 * @property {string} [confirm] Rueckfrage vor dem Ausfuehren
 * @property {number} timeoutMs
 * @property {string} script laeuft am Pi als root unter /bin/sh (kein bash)
 */

// Lang laufende Eingriffe (Paket-Update, System-Update) starten als
// transiente systemd-Unit: sie ueberleben das Ende der SSH-Sitzung, und
// openHAB oder der Tunnel duerfen dabei neu starten. Den Verlauf zeigen die
// zugehoerigen Protokoll-Abfragen. "Laeuft schon?" prueft auf active und
// activating: die oneshot-Unit des Timers (stromkreis-update.service) steht
// waehrend des Laufs auf activating.
/** @type {RemoteAction[]} */
const ACTIONS = [
	{
		id: 'neustart',
		kind: 'aktion',
		label: 'Neustart',
		description: 'Startet den Raspberry Pi neu. Die Anlage ist danach einige Minuten offline.',
		confirm:
			'Raspberry Pi jetzt neu starten? Die Steuerung ruht währenddessen einige Minuten (Fail-Safe bzw. Auto-Revert greifen).',
		timeoutMs: 30000,
		// Verzoegert, damit die SSH-Sitzung noch sauber mit Exit 0 endet.
		script: `systemd-run --quiet --on-active=3 --timer-property=AccuracySec=1s /bin/systemctl reboot || exit 1
echo "Neustart eingeleitet. Die Anlage meldet sich in einigen Minuten wieder."`
	},
	{
		id: 'openhab_neustart',
		kind: 'aktion',
		label: 'openHAB neu starten',
		description: 'Startet nur den openHAB-Dienst neu, der Pi läuft weiter.',
		confirm: 'openHAB jetzt neu starten? Die Steuerung ruht, bis openHAB wieder läuft (einige Minuten).',
		timeoutMs: 240000,
		script: `systemctl restart openhab.service || exit 1
echo "openhab.service: $(systemctl is-active openhab.service)"
echo "openHAB braucht nach dem Start noch einige Minuten, bis Regeln und Main UI bereit sind."`
	},
	{
		id: 'paket_update',
		kind: 'aktion',
		label: 'Update',
		description: 'Spielt das aktuelle Stromkreis-Gateway-Paket von der Plattform neu ein (stromkreis-update).',
		confirm: 'Gateway-Paket jetzt aktualisieren? openHAB kann dabei neu starten.',
		timeoutMs: 30000,
		script: `[ -x /usr/local/sbin/stromkreis-update ] || { echo "stromkreis-update ist auf diesem Gateway nicht installiert (INSTALL_AUTO_UPDATE=0?)."; exit 1; }
if systemctl is-active stromkreis-update-manuell.service stromkreis-update.service 2>/dev/null | grep -qE "^(active|activating)$"; then
  echo "Ein Paket-Update läuft bereits. Verlauf: Update-Protokoll."
  exit 0
fi
systemd-run --quiet --collect --unit=stromkreis-update-manuell /usr/local/sbin/stromkreis-update --now || exit 1
echo "Paket-Update gestartet, es läuft im Hintergrund weiter (einige Minuten). Verlauf: Update-Protokoll."`
	},
	{
		id: 'system_update',
		kind: 'aktion',
		label: 'System-Update',
		description:
			'Aktualisiert die Paketlisten und spielt die Betriebssystem-Updates ein (unattended-upgrade: Debian und Raspberry Pi). openHAB und Java bleiben bewusst Handarbeit.',
		confirm: 'Betriebssystem-Updates jetzt einspielen? Das kann 10 bis 30 Minuten dauern.',
		timeoutMs: 30000,
		script: `command -v unattended-upgrade >/dev/null 2>&1 || { echo "unattended-upgrades ist auf diesem Gateway nicht installiert."; exit 1; }
if systemctl is-active --quiet stromkreis-systemupdate.service; then
  echo "Ein System-Update läuft bereits. Verlauf: System-Update-Protokoll."
  exit 0
fi
systemd-run --quiet --collect --unit=stromkreis-systemupdate --setenv=DEBIAN_FRONTEND=noninteractive /bin/sh -c "apt-get update && unattended-upgrade -v" || exit 1
echo "System-Update gestartet, es läuft im Hintergrund weiter. Verlauf: System-Update-Protokoll."
echo "Verlangt ein Update einen Neustart, zeigt das der Systemzustand an."`
	},
	{
		id: 'systemzustand',
		kind: 'abfrage',
		label: 'Systemzustand',
		description: 'Laufzeit, Temperatur, Speicher, SD-Karte, Dienste und Tunnel.',
		timeoutMs: 30000,
		script: `echo "== System =="
uptime
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  awk '{ printf "CPU-Temperatur: %.1f °C\\n", $1 / 1000 }' /sys/class/thermal/thermal_zone0/temp
fi
if [ -e /run/reboot-required ]; then echo "Neustart erforderlich (/run/reboot-required)."; else echo "Kein Neustart ausstehend."; fi
echo
echo "== Speicher =="
free -m
echo
df -h / /boot/firmware 2>/dev/null || df -h /
echo
echo "== Dienste =="
for u in openhab.service wg-quick@wg0.service stromkreis-update.timer stromkreis-failsafe.timer apt-daily-upgrade.timer; do
  printf "%-30s %s\\n" "$u" "$(systemctl is-active "$u" 2>/dev/null)"
done
echo
echo "== Tunnel =="
wg show wg0 2>/dev/null | grep -E "latest handshake|transfer" || echo "wg0 nicht aktiv."
exit 0`
	},
	{
		id: 'update_protokoll',
		kind: 'abfrage',
		label: 'Update-Protokoll',
		description: 'Letzte Zeilen aus /var/log/stromkreis-update.log.',
		timeoutMs: 30000,
		script: `if systemctl is-active stromkreis-update-manuell.service stromkreis-update.service 2>/dev/null | grep -qE "^(active|activating)$"; then
  echo "Paket-Update läuft gerade."
else
  echo "Kein Paket-Update aktiv."
fi
echo "Installiertes Paket: $(cut -c1-12 ${SETUP_DIR}/../PACKAGE-SHA256 2>/dev/null || echo unbekannt)"
echo
tail -n 60 /var/log/stromkreis-update.log 2>/dev/null || echo "Noch kein Update-Protokoll vorhanden."
exit 0`
	},
	{
		id: 'systemupdate_protokoll',
		kind: 'abfrage',
		label: 'System-Update-Protokoll',
		description: 'Verlauf des letzten System-Updates und Ende von unattended-upgrades.log.',
		timeoutMs: 30000,
		script: `if systemctl is-active --quiet stromkreis-systemupdate.service; then
  echo "System-Update läuft gerade."
else
  echo "Kein System-Update aktiv."
fi
echo
echo "== Letzter Lauf vom Dashboard =="
journalctl -u stromkreis-systemupdate.service -n 40 --no-pager -o cat 2>/dev/null
echo
echo "== unattended-upgrades.log =="
tail -n 30 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null || echo "Noch kein Protokoll vorhanden."
exit 0`
	},
	{
		id: 'einrichtung_pruefen',
		kind: 'abfrage',
		label: 'Einrichtung prüfen',
		description: 'Lässt die Prüfung des Gateway-Pakets laufen (06-verify.sh, ändert nichts).',
		timeoutMs: 180000,
		script: `[ -x ${SETUP_DIR}/06-verify.sh ] || { echo "${SETUP_DIR}/06-verify.sh nicht gefunden."; exit 1; }
${SETUP_DIR}/06-verify.sh 2>&1`
	}
];

/** Aktionsliste fuer die Oberflaeche - ohne die Skripte. */
export function listRemoteActions() {
	return ACTIONS.map(({ id, kind, label, description, confirm }) => ({
		id,
		kind,
		label,
		description,
		confirm: confirm ?? null
	}));
}

// Je Anlage laeuft hoechstens eine Aktion (Doppelklick, zwei Betreiber).
/** @type {Set<string>} */
const running = new Set();

function socksHost() {
	return env.WG_SOCKS_HOST || 'wireguard';
}
function socksPort() {
	return Number(env.WG_SOCKS_PORT || 1080);
}

/**
 * Minimaler SOCKS5-Client (ohne Auth, CONNECT auf eine IPv4-Adresse).
 * Reicht fuer den microsocks im WireGuard-Container; erspart eine weitere
 * Abhaengigkeit.
 * @param {string} dstIp IPv4 im Wartungsnetz
 * @param {number} dstPort
 * @returns {Promise<import('node:net').Socket>}
 */
function socksConnect(dstIp, dstPort) {
	return new Promise((resolve, reject) => {
		const parts = dstIp.split('.').map(Number);
		if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
			reject(new Error(`Keine IPv4-Adresse: ${dstIp}`));
			return;
		}
		const sock = netConnect({ host: socksHost(), port: socksPort() });
		sock.setNoDelay(true);
		let stage = 0; // 0 = Methodenwahl offen, 1 = CONNECT offen
		let buf = Buffer.alloc(0);
		const fail = (/** @type {string} */ msg) => {
			clearTimeout(timer);
			sock.destroy();
			reject(new Error(msg));
		};
		// Ein Deadline fuer den ganzen Handshake: ein Gateway ohne stehenden
		// Tunnel laesst den CONNECT sonst minutenlang haengen.
		const timer = setTimeout(
			() =>
				fail(
					stage === 0
						? 'SOCKS-Durchgang antwortet nicht (WireGuard-Container erreichbar?).'
						: 'Gateway über den Tunnel nicht erreichbar (Zeitüberschreitung, Tunnel steht nicht?).'
				),
			15000
		);
		sock.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`SOCKS-Durchgang nicht erreichbar: ${e.message}`));
		});
		sock.on('connect', () => {
			sock.write(Buffer.from([0x05, 0x01, 0x00])); // SOCKS5, eine Methode: ohne Auth
		});
		sock.on('data', (/** @type {Buffer} */ chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (stage === 0) {
				if (buf.length < 2) return;
				if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('SOCKS-Durchgang lehnt ab.');
				buf = buf.subarray(2);
				stage = 1;
				sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts, dstPort >> 8, dstPort & 0xff]));
			}
			if (stage === 1) {
				if (buf.length < 10) return;
				if (buf[1] !== 0x00) {
					const reasons = /** @type {Record<number, string>} */ ({
						1: 'allgemeiner Fehler',
						3: 'Wartungsnetz nicht erreichbar',
						4: 'Gateway nicht erreichbar (Tunnel steht nicht?)',
						5: 'Verbindung abgelehnt'
					});
					return fail(`Gateway über den Tunnel nicht erreichbar: ${reasons[buf[1]] || `SOCKS-Code ${buf[1]}`}.`);
				}
				sock.removeAllListeners('data');
				sock.removeAllListeners('error');
				clearTimeout(timer);
				const rest = buf.subarray(10);
				if (rest.length) sock.unshift(rest);
				resolve(sock);
			}
		});
	});
}

/**
 * Einen Befehl ueber die stehende SSH-Verbindung ausfuehren; stdout und
 * stderr landen gemeinsam in der Ausgabe (nur das Ende, OUTPUT_BYTES).
 * @param {import('ssh2').Client} client
 * @param {string} command
 * @param {{stdin?: string, timeoutMs: number}} opts
 * @returns {Promise<{code: number | null, output: string, timedOut: boolean}>}
 */
function execCommand(client, command, { stdin, timeoutMs }) {
	return new Promise((resolve, reject) => {
		client.exec(command, (/** @type {any} */ err, /** @type {any} */ stream) => {
			if (err) {
				reject(new Error(`SSH-Befehl fehlgeschlagen: ${err.message}`));
				return;
			}
			/** @type {Buffer[]} */
			const chunks = [];
			let bytes = 0;
			let done = false;
			const finish = (/** @type {number | null} */ code, /** @type {boolean} */ timedOut) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut });
			};
			const timer = setTimeout(() => {
				try {
					stream.close();
				} catch {}
				finish(null, true);
			}, timeoutMs);
			const onData = (/** @type {Buffer} */ chunk) => {
				chunks.push(chunk);
				bytes += chunk.length;
				while (bytes > OUTPUT_BYTES && chunks.length > 1) {
					bytes -= /** @type {Buffer} */ (chunks.shift()).length;
				}
			};
			stream.on('data', onData);
			stream.stderr.on('data', onData);
			stream.on('close', (/** @type {number | null} */ code) => finish(typeof code === 'number' ? code : null, false));
			stream.end(stdin ?? '');
		});
	});
}

/** @param {string} text */
function shellQuote(text) {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wartungsaktion auf dem Gateway einer Anlage ausfuehren.
 * @param {number} tenantId
 * @param {number} siteId
 * @param {string} actionId Kennung aus ACTIONS; alles andere wird abgelehnt
 * @returns {Promise<{id: string, label: string, ok: boolean, exit_code: number | null, output: string, at: string}>}
 */
export async function runRemoteAction(tenantId, siteId, actionId) {
	const action = ACTIONS.find((a) => a.id === actionId);
	if (!action) throw new Error('Unbekannte Aktion.');

	const [site] = await sql`
		select name, wg_address, coalesce(wg_public_key, '') <> '' as wg_key_reported,
			status->>'linux_password' as linux_password
		from battery_site where tenant_id = ${tenantId} and id = ${siteId}`;
	if (!site) throw new Error('Anlage nicht gefunden.');
	if (!site.wg_address) throw new Error('Die Anlage hat noch keine Tunnel-IP.');
	if (!site.wg_key_reported) {
		throw new Error('Das Gateway hat seinen Tunnel-Schlüssel noch nicht gemeldet.');
	}
	if (!site.linux_password) {
		throw new Error('Kein Anlagen-Passwort hinterlegt (Anlage vor der Passwort-Verwaltung eingerichtet?).');
	}

	const key = `${tenantId}:${siteId}`;
	if (running.has(key)) throw new Error('Auf dieser Anlage läuft bereits eine Aktion; bitte kurz warten.');
	running.add(key);
	const client = new Client();
	try {
		const sock = await socksConnect(site.wg_address, 22);
		await new Promise((resolve, reject) => {
			client.on('error', (e) => reject(new Error(`SSH fehlgeschlagen: ${e.message}`)));
			client.on('ready', () => resolve(undefined));
			client.connect({
				sock,
				username: 'openhabian',
				password: site.linux_password,
				readyTimeout: 20000,
				keepaliveInterval: 15000,
				keepaliveCountMax: 3
			});
		});

		// Die Skripte laufen als root. openHABian erlaubt sudo je nach Stand
		// ohne Passwort; sonst bekommt sudo das Anlagen-Passwort auf stdin.
		// Nur dann wird es ueberhaupt geschrieben - so landet es nie in der
		// Standardeingabe des eigentlichen Skripts.
		const probe = await execCommand(client, 'sudo -n true', { timeoutMs: 15000 });
		const quoted = shellQuote(action.script);
		const result =
			probe.code === 0
				? await execCommand(client, `sudo -n /bin/sh -c ${quoted}`, { timeoutMs: action.timeoutMs })
				: await execCommand(client, `sudo -S -p '' /bin/sh -c ${quoted}`, {
						stdin: `${site.linux_password}\n`,
						timeoutMs: action.timeoutMs
					});

		let output = result.output.trimEnd();
		if (result.timedOut) {
			output += `${output ? '\n' : ''}Zeitüberschreitung nach ${Math.round(action.timeoutMs / 1000)} s; die Verbindung wurde getrennt.`;
		}
		const ok = !result.timedOut && result.code === 0;
		console.log(
			`fernwartung: mandant ${tenantId} anlage ${siteId} (${site.name}) aktion ${action.id}: ${ok ? 'ok' : `fehler (exit ${result.code})`}`
		);
		return {
			id: action.id,
			label: action.label,
			ok,
			exit_code: result.code,
			output,
			at: new Date().toISOString()
		};
	} finally {
		running.delete(key);
		try {
			client.end();
		} catch {}
	}
}
