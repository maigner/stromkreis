import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sql } from './db.js';
import {
	platformBaseUrl,
	randomPassword,
	renderOpenhabianConf,
	renderProvisionConf,
	renderUserData
} from './gateway-provision.js';

// Fertige SD-Karten-Images je Anlage, portiert aus dem ISCHLSTROM-Repo
// (website/src/lib/server/ibmImage.js): offizielles openHABian-Basis-Image
// plus openhabian.conf, stromkreis-provision.conf und user-data auf der
// FAT-Boot-Partition (eingespielt mit mcopy/mtools, kein Root noetig), als
// site-<id>.img.gz zum Flashen mit dem Raspberry Pi Imager auf jedem
// Betriebssystem. Auch der Restore einer defekten Karte laeuft so:
// "Neuer Code", Image neu erstellen, flashen.
//
// Ablage unter IMAGE_DIR (Produktion: Bind-Mount, siehe deploy/docker-compose.yml).
// Je Anlage liegt dort site-<id>.img.gz, site-<id>.json (Metadaten: Code,
// Stand) und ggf. site-<id>.error; das Basis-Image wird unter base/ gecacht.
// Es baut immer nur ein Image gleichzeitig (alle Mandanten zusammen); der
// Fortschritt steckt im Prozess (Neustart bricht den Bau ab, der Zustand
// faellt dann auf die Dateien zurueck).

const RELEASES_API = 'https://api.github.com/repos/openhab/openhabian/releases/latest';
const NEEDED_BYTES = 7e9; // Basis-Image + entpacktes Arbeits-Image + Ergebnis

/** Laufender Bau (nur einer gleichzeitig, ueber alle Mandanten).
 *  @type {{ siteId: number, phase: string, startedAt: string } | null} */
let current = null;

function imageDir() {
	return env.IMAGE_DIR || (dev ? 'data/images' : '/var/lib/stromkreis/images');
}

/** @param {number} siteId */
const imageFile = (siteId) => path.join(imageDir(), `site-${siteId}.img.gz`);
/** @param {number} siteId */
const metaFile = (siteId) => path.join(imageDir(), `site-${siteId}.json`);
/** @param {number} siteId */
const errorFile = (siteId) => path.join(imageDir(), `site-${siteId}.error`);

/** @param {string} file */
async function readJson(file) {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Zustand fuer die Oberflaeche: `building` waehrend des Baus, `image` wenn ein
 * fertiges Image liegt (`stale`, wenn es mit einem anderen als dem aktuellen
 * Code gebaut wurde oder der Code abgelaufen ist), `error` wenn der letzte
 * Bau fehlschlug (ein aelteres Image bleibt daneben nutzbar).
 * @param {{ id: number, provision_code: string | null, provision_expires_at: Date | string | null }} site
 */
export async function getImageStatus(site) {
	// battery_site.id ist bigint und kommt aus postgres.js als String
	const id = Number(site.id);
	const building = current && current.siteId === id
		? { phase: current.phase, startedAt: current.startedAt }
		: null;
	const meta = await readJson(metaFile(id));
	const err = await readJson(errorFile(id));
	const expired = site.provision_expires_at && new Date(site.provision_expires_at) < new Date();
	return {
		building,
		other_building: Boolean(current && current.siteId !== id),
		image: meta
			? {
					builtAt: /** @type {string} */ (meta.builtAt),
					size: /** @type {number} */ (meta.size),
					stale: meta.code !== site.provision_code || Boolean(expired)
				}
			: null,
		error: !building && err && (!meta || err.at > meta.builtAt)
			? { message: /** @type {string} */ (err.message), at: /** @type {string} */ (err.at) }
			: null
	};
}

/** Pfad und Groesse des fertigen Images, oder null. @param {number} siteId */
export async function imageDownload(siteId) {
	const file = imageFile(siteId);
	try {
		const stat = await fs.stat(file);
		return { file, size: stat.size, stream: () => createReadStream(file) };
	} catch {
		return null;
	}
}

/** Image-Dateien einer Anlage entfernen (beim Loeschen der Anlage). @param {number} siteId */
export async function deleteImage(siteId) {
	for (const f of [imageFile(siteId), metaFile(siteId), errorFile(siteId)]) {
		await fs.rm(f, { force: true });
	}
}

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr?.on('data', (d) => (stderr += d));
		child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
		child.on('close', (code) =>
			code === 0 ? resolve(undefined) : reject(new Error(`${cmd} (Exit ${code}): ${stderr.trim().slice(0, 500)}`))
		);
	});
}

/** Byte-Offset der ersten Partition (FAT-Boot-Partition) aus dem MBR. @param {string} img */
async function bootPartitionOffset(img) {
	const fh = await fs.open(img, 'r');
	try {
		const mbr = Buffer.alloc(512);
		await fh.read(mbr, 0, 512, 0);
		if (mbr.readUInt16LE(510) !== 0xaa55) throw new Error('Image ohne MBR-Signatur.');
		const type = mbr[446 + 4];
		if (type !== 0x0b && type !== 0x0c) {
			throw new Error(`Erste Partition ist keine FAT32 (Typ 0x${type.toString(16)}).`);
		}
		return mbr.readUInt32LE(446 + 8) * 512;
	} finally {
		await fh.close();
	}
}

/**
 * Aktuelles openHABian-Basis-Image (64-bit) in den Cache laden; bei
 * Netzproblemen wird das neueste bereits gecachte verwendet.
 */
async function ensureBaseImage() {
	const baseDir = path.join(imageDir(), 'base');
	await fs.mkdir(baseDir, { recursive: true });
	const cached = (await fs.readdir(baseDir)).filter((f) => f.endsWith('.img.xz')).sort();

	let name = '';
	let url = '';
	try {
		const release = await (await fetch(RELEASES_API)).json();
		const assets = (release.assets ?? [])
			.filter((/** @type {any} */ a) => a.name.startsWith('openhabian-raspios64') && a.name.endsWith('.img.xz'))
			.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
		const asset = assets.at(-1);
		if (asset) ({ name, browser_download_url: url } = asset);
	} catch {
		// unten: Cache-Fallback
	}
	if (!name) {
		const newest = cached.at(-1);
		if (!newest) throw new Error('openHABian-Releaseliste nicht erreichbar und kein Basis-Image im Cache.');
		return path.join(baseDir, newest);
	}

	const file = path.join(baseDir, name);
	if (!cached.includes(name)) {
		const res = await fetch(url);
		if (!res.ok || !res.body) throw new Error(`Basis-Image nicht ladbar (HTTP ${res.status}).`);
		await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), createWriteStream(`${file}.part`));
		await fs.rename(`${file}.part`, file);
		// alte Basis-Images aufraeumen
		for (const old of cached) await fs.rm(path.join(baseDir, old), { force: true });
	}
	return file;
}

/**
 * Startet den Bau des SD-Karten-Images einer Anlage im Hintergrund
 * (tenant-gescoped geladen, Aufrufer sind die Betreiber-Aktionen).
 * Wirft sofort, wenn schon ein Bau laeuft oder der Code fehlt; der Ausgang
 * steht danach in getImageStatus() (site-<id>.json bzw. site-<id>.error).
 *
 * @param {number} tenantId
 * @param {number} siteId
 */
export async function startImageBuild(tenantId, siteId) {
	const [site] = await sql`
		select id, name, status, provision_code, provision_expires_at
		from battery_site where tenant_id = ${tenantId} and id = ${siteId}
	`;
	if (!site) throw new Error('Anlage nicht gefunden.');
	if (!site.provision_code || !site.provision_expires_at || new Date(site.provision_expires_at) < new Date()) {
		throw new Error('Kein gueltiger Einrichtungscode - zuerst "Neuer Code".');
	}
	if (current) {
		throw new Error(
			current.siteId === Number(site.id)
				? 'Dieses Image wird gerade gebaut.'
				: 'Es wird gerade ein anderes Image gebaut - bitte kurz warten.'
		);
	}

	// Aeltere Anlagen (vor der Provisionierung angelegt) haben noch kein
	// Linux-Passwort im Status; hier nachziehen, es steht in der openhabian.conf.
	let linuxPassword = site.status?.linux_password;
	if (!linuxPassword) {
		linuxPassword = randomPassword();
		await sql`
			update battery_site set status = status || ${sql.json({ linux_password: linuxPassword })}
			where tenant_id = ${tenantId} and id = ${siteId}
		`;
	}

	await fs.mkdir(imageDir(), { recursive: true });
	const stat = await fs.statfs(imageDir());
	if (stat.bavail * stat.bsize < NEEDED_BYTES) {
		throw new Error('Zu wenig freier Speicher fuer den Image-Bau (7 GB noetig).');
	}

	const files = {
		'openhabian.conf': renderOpenhabianConf({
			hostname: `stromkreis-${site.id}`,
			userPassword: linuxPassword,
			wifiSsid: site.status?.wifi_ssid ?? null,
			wifiPassword: site.status?.wifi_password ?? null
		}),
		'stromkreis-provision.conf': renderProvisionConf({ code: site.provision_code, baseUrl: platformBaseUrl() }),
		'user-data': renderUserData()
	};

	const state = { siteId: Number(site.id), phase: 'Basis-Image laden', startedAt: new Date().toISOString() };
	current = state;
	void build(Number(site.id), site.provision_code, files, state).catch(() => {});
}

/** @param {number} siteId @param {string} code @param {Record<string, string>} files @param {{ phase: string }} state */
async function build(siteId, code, files, state) {
	const work = path.join(imageDir(), `site-${siteId}.work.img`);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stromkreis-image-'));
	try {
		const base = await ensureBaseImage();

		state.phase = 'Basis-Image entpacken';
		const xz = spawn('xz', ['-dc', base], { stdio: ['ignore', 'pipe', 'pipe'] });
		let xzErr = '';
		xz.stderr.on('data', (d) => (xzErr += d));
		const done = new Promise((resolve, reject) => {
			xz.on('close', (rc) => (rc === 0 ? resolve(undefined) : reject(new Error(`xz (Exit ${rc}): ${xzErr.trim()}`))));
			xz.on('error', (e) => reject(new Error(`xz: ${e.message}`)));
		});
		await pipeline(xz.stdout, createWriteStream(work));
		await done;

		state.phase = 'Konfiguration einspielen';
		const offset = await bootPartitionOffset(work);
		for (const [file, content] of Object.entries(files)) {
			await fs.writeFile(path.join(tmp, file), content);
		}
		await run('mcopy', ['-o', '-i', `${work}@@${offset}`, ...Object.keys(files).map((f) => path.join(tmp, f)), '::/']);

		state.phase = 'komprimieren';
		await pipeline(createReadStream(work), zlib.createGzip({ level: 6 }), createWriteStream(`${imageFile(siteId)}.part`));
		await fs.rename(`${imageFile(siteId)}.part`, imageFile(siteId));

		const size = (await fs.stat(imageFile(siteId))).size;
		await fs.writeFile(metaFile(siteId), JSON.stringify({
			code,
			base: path.basename(base),
			builtAt: new Date().toISOString(),
			size
		}));
		await fs.rm(errorFile(siteId), { force: true });
	} catch (e) {
		await fs.writeFile(errorFile(siteId), JSON.stringify({
			message: e instanceof Error ? e.message : String(e),
			at: new Date().toISOString()
		})).catch(() => {});
	} finally {
		current = null;
		await fs.rm(work, { force: true });
		await fs.rm(`${imageFile(siteId)}.part`, { force: true });
		await fs.rm(tmp, { recursive: true, force: true });
	}
}
