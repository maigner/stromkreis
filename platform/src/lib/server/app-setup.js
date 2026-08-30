// Einrichtung der Stromkreis-App (Fork der openHAB-App): ein Einmal-Token wird
// als QR-Code bzw. Universal Link https://stromkreis.net/app/setup/<token>
// an das Mitglied gegeben; die App loest ihn einmalig gegen die Cloud-
// Zugangsdaten der Anlage ein (POST /api/app/setup/v1). Serverkontrakt:
// docs/stromkreis-onboarding.md im App-Repository.
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '$lib/server/db.js';
import { hashToken } from '$lib/server/auth.js';
import { platformBaseUrl } from '$lib/server/gateway-provision.js';

export const APP_SETUP_TOKEN_DAYS = 7;

/** @param {string} token */
export function appSetupLink(token) {
	return `${platformBaseUrl()}/app/setup/${token}`;
}

/**
 * Erzeugt einen neuen Einmal-Token fuer die Anlage; alte Tokens der Anlage
 * werden dabei ungueltig. Liefert null, wenn die Anlage nicht existiert
 * (bzw. einem anderen Mandanten gehoert).
 * @param {number} tenantId
 * @param {number} siteId
 * @returns {Promise<{ link: string, expires_at: Date } | null>}
 */
export async function createAppSetupToken(tenantId, siteId) {
	const [site] = await sql`
		select id from battery_site where tenant_id = ${tenantId} and id = ${siteId}
	`;
	if (!site) return null;
	const token = randomBytes(24).toString('base64url');
	await sql`delete from app_setup_token where tenant_id = ${tenantId} and site_id = ${siteId}`;
	const [row] = await sql`
		insert into app_setup_token (tenant_id, site_id, token_hash, expires_at)
		values (${tenantId}, ${siteId}, ${hashToken(token)}, now() + make_interval(days => ${APP_SETUP_TOKEN_DAYS}))
		returning expires_at
	`;
	return { link: appSetupLink(token), expires_at: row.expires_at };
}

/**
 * QR-Code als SVG-String (dunkel auf transparent; im UI auf weissen
 * Hintergrund legen, damit er zuverlaessig gescannt wird).
 * @param {string} text
 */
export function qrSvg(text) {
	return QRCode.toString(text, {
		type: 'svg',
		errorCorrectionLevel: 'M',
		margin: 0,
		color: { dark: '#1c1917', light: '#ffffff00' }
	});
}
