// ============================================================================
// Echte SSH-Sitzungen auf die Gateways, aus der Anlagen-Detailseite heraus.
//
// Weg: Browser (xterm.js) <-> Plattform (SSE fuer die Ausgabe, POST fuer die
// Eingabe) <-> ssh2-Client <-> SOCKS5-Durchgang im WireGuard-Container
// (microsocks, nur im Compose-Netz erreichbar) <-> Wartungsnetz wg0 <-> Pi.
//
// Die Anmeldung am Pi ist normales SSH mit Passwort (openhabian + Anlagen-
// Passwort aus status.linux_password); der Browser bekommt das Passwort nie
// zu sehen. Ohne Host-Key-Pruefung (wie accept-new bei wg-ssh.sh): die
// Gegenstellen wechseln mit jeder Neuinstallation, das Wartungsnetz ist
// nur ueber den Tunnel erreichbar - dokumentiertes Restrisiko.
// ============================================================================
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from 'ssh2';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // ohne Ein-/Ausgabe schliessen
const MAX_SESSIONS = 20; // Plattform-weit; Wartungszugang, kein Massenbetrieb
const BACKLOG_BYTES = 256 * 1024; // Ausgabe-Puffer je Sitzung (fuer Reconnect)

/**
 * @typedef {Object} SshSession
 * @property {string} id
 * @property {number} tenantId
 * @property {number} siteId
 * @property {import('ssh2').Client} client
 * @property {any} shell
 * @property {Buffer[]} backlog
 * @property {number} backlogBytes
 * @property {Set<(chunk: Buffer) => void>} listeners
 * @property {Set<() => void>} closeListeners
 * @property {boolean} closed
 * @property {ReturnType<typeof setTimeout>} idleTimer
 */

/** @type {Map<string, SshSession>} */
const sessions = new Map();

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

/** @param {SshSession} s */
function touch(s) {
	clearTimeout(s.idleTimer);
	s.idleTimer = setTimeout(() => closeSession(s.id), IDLE_TIMEOUT_MS);
}

/** @param {string} id */
export function closeSession(id) {
	const s = sessions.get(id);
	if (!s) return;
	sessions.delete(id);
	s.closed = true;
	clearTimeout(s.idleTimer);
	for (const cb of s.closeListeners) cb();
	s.closeListeners.clear();
	s.listeners.clear();
	try {
		s.shell.close();
	} catch {}
	try {
		s.client.end();
	} catch {}
}

/**
 * Sitzung holen, aber nur wenn sie dem Mandanten und der Anlage gehoert.
 * @param {string} id
 * @param {number} tenantId
 * @param {number} siteId
 */
export function getSession(id, tenantId, siteId) {
	const s = sessions.get(id);
	if (!s || s.closed || s.tenantId !== tenantId || s.siteId !== siteId) return null;
	return s;
}

/**
 * SSH-Sitzung auf das Gateway einer Anlage oeffnen.
 * @param {number} tenantId
 * @param {number} siteId
 * @param {{cols?: number, rows?: number}} [size]
 * @returns {Promise<{id: string}>}
 */
export async function openSession(tenantId, siteId, size = {}) {
	if (sessions.size >= MAX_SESSIONS) {
		throw new Error('Zu viele offene SSH-Sitzungen; bitte eine schließen.');
	}
	const [site] = await sql`
		select wg_address, coalesce(wg_public_key, '') <> '' as wg_key_reported,
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

	const sock = await socksConnect(site.wg_address, 22);
	const client = new Client();
	const shell = await new Promise((resolve, reject) => {
		client.on('error', (e) => reject(new Error(`SSH fehlgeschlagen: ${e.message}`)));
		client.on('ready', () => {
			client.shell(
				{ term: 'xterm-256color', cols: size.cols || 120, rows: size.rows || 32 },
				(/** @type {any} */ err, /** @type {any} */ stream) => (err ? reject(err) : resolve(stream))
			);
		});
		client.connect({
			sock,
			username: 'openhabian',
			password: site.linux_password,
			readyTimeout: 20000,
			keepaliveInterval: 30000,
			keepaliveCountMax: 3
		});
	});

	const id = randomBytes(18).toString('base64url');
	/** @type {SshSession} */
	const session = {
		id,
		tenantId,
		siteId,
		client,
		shell,
		backlog: [],
		backlogBytes: 0,
		listeners: new Set(),
		closeListeners: new Set(),
		closed: false,
		idleTimer: setTimeout(() => closeSession(id), IDLE_TIMEOUT_MS)
	};
	sessions.set(id, session);

	const onData = (/** @type {Buffer} */ chunk) => {
		touch(session);
		session.backlog.push(chunk);
		session.backlogBytes += chunk.length;
		while (session.backlogBytes > BACKLOG_BYTES && session.backlog.length > 1) {
			session.backlogBytes -= /** @type {Buffer} */ (session.backlog.shift()).length;
		}
		for (const cb of session.listeners) cb(chunk);
	};
	shell.on('data', onData);
	shell.stderr.on('data', onData);
	shell.on('close', () => closeSession(id));
	client.on('close', () => closeSession(id));
	client.on('error', () => closeSession(id));
	return { id };
}

/**
 * Tastatureingabe an die Sitzung.
 * @param {SshSession} s
 * @param {string} dataB64 Base64-kodierte Bytes vom Terminal
 */
export function writeInput(s, dataB64) {
	touch(s);
	s.shell.write(Buffer.from(dataB64, 'base64'));
}

/**
 * Terminalgroesse nachziehen.
 * @param {SshSession} s
 * @param {number} cols
 * @param {number} rows
 */
export function resize(s, cols, rows) {
	if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
		s.shell.setWindow(rows, cols, 0, 0);
	}
}

/**
 * SSE-Strom der Terminalausgabe: erst der Puffer (Reconnect zeigt den
 * bisherigen Bildschirm), dann live. Chunks Base64-kodiert (SSE ist
 * zeilenbasiert, Terminalausgabe nicht).
 * @param {SshSession} s
 * @returns {ReadableStream<Uint8Array>}
 */
export function outputStream(s) {
	const encoder = new TextEncoder();
	/** @type {(chunk: Buffer) => void} */
	let onChunk;
	/** @type {() => void} */
	let onClose;
	return new ReadableStream({
		start(controller) {
			const send = (/** @type {Buffer} */ chunk) => {
				try {
					controller.enqueue(encoder.encode(`data: ${chunk.toString('base64')}\n\n`));
				} catch {}
			};
			for (const chunk of s.backlog) send(chunk);
			onChunk = send;
			onClose = () => {
				try {
					controller.enqueue(encoder.encode('event: end\ndata: closed\n\n'));
					controller.close();
				} catch {}
			};
			s.listeners.add(onChunk);
			s.closeListeners.add(onClose);
		},
		cancel() {
			s.listeners.delete(onChunk);
			s.closeListeners.delete(onClose);
		}
	});
}
