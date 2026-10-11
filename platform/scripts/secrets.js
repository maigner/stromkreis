// Ver- und Entschluesselung fuer die Provider-Skripte, gleiches Format wie
// src/lib/server/secrets.js (enc1:<iv>:<ct+tag>, AES-256-GCM, TOKEN_SECRET
// aus der Umgebung); die Skripte koennen $env/$lib nicht importieren.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
	const hex = process.env.TOKEN_SECRET;
	if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error('TOKEN_SECRET fehlt oder hat nicht 64 Hex-Zeichen (openssl rand -hex 32)');
	}
	return Buffer.from(hex, 'hex');
}

/** @param {string} plain */
export function encrypt(plain) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
	return `enc1:${iv.toString('base64')}:${ct.toString('base64')}`;
}

/** @param {string} value */
export function decrypt(value) {
	const [tag, ivB64, ctB64] = value.split(':');
	if (tag !== 'enc1' || !ivB64 || !ctB64) throw new Error('Unbekanntes Chiffrat-Format');
	const ct = Buffer.from(ctB64, 'base64');
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(ct.subarray(ct.length - 16));
	return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf8');
}

/** Klartext-Altbestand unveraendert, Chiffrat entschluesselt. @param {string | null} value */
export function readSecret(value) {
	if (!value) return null;
	return value.startsWith('enc1:') ? decrypt(value) : value;
}
