// Verschluesselung fuer Secrets in der Datenbank (Refresh-Tokens) und signierte
// Kurzzeit-Cookies (Login-Zwischenstand). Schluessel: TOKEN_SECRET aus der
// Server-.env (64 Hex-Zeichen = 32 Byte). Format der Chiffrate:
// enc1:<iv base64>:<ciphertext+tag base64>, AES-256-GCM. Die Pipeline
// (pipeline/stromkreis_pipeline/secrets.py) liest dasselbe Format.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

function key() {
    const hex = env.TOKEN_SECRET;
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

/**
 * Signiertes Kurzzeit-Cookie: base64url(JSON).base64url(HMAC-SHA256).
 * @param {unknown} payload
 * @param {number} ttlSeconds
 */
export function signCookie(payload, ttlSeconds) {
    const body = Buffer.from(JSON.stringify({ ...(/** @type {object} */ (payload)), exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const mac = createHmac('sha256', key()).update(body).digest('base64url');
    return `${body}.${mac}`;
}

/**
 * @param {string | undefined} value
 * @returns {any | null} Payload oder null (ungueltig/abgelaufen)
 */
export function verifyCookie(value) {
    if (!value) return null;
    const [body, mac] = value.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', key()).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
        return payload;
    } catch {
        return null;
    }
}
