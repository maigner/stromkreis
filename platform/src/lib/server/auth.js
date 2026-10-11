import { createHash, randomBytes } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import { sql } from './db.js';

// Rollen (member.role): operator = Betreiber, darf alles im Betreiberbereich;
// board = Vorstand, sieht die Auswertungen, aber keine Geheimnisse und keine
// Eingriffe; member = Mitglied, hat im Betreiberbereich nichts zu suchen.
// Jede Aktion unter /intern prueft serverseitig; die Oberflaeche blendet
// Formulare fuer Nicht-Betreiber nur zusaetzlich aus.
export const INTERN_ROLES = /** @type {const} */ (['operator', 'board']);

/**
 * Angemeldeter Benutzer mit Zugang zum Betreiberbereich, sonst Umleitung
 * zur Startseite (keine Session) bzw. 403 (Rolle member).
 * @param {App.Locals} locals
 * @returns {App.User}
 */
export function requireUser(locals) {
	if (!locals.user) redirect(303, '/');
	if (!INTERN_ROLES.includes(/** @type {any} */ (locals.user.role))) {
		error(403, 'Dieses Konto hat keinen Zugang zum Betreiberbereich.');
	}
	return locals.user;
}

/**
 * Betreiber-Rolle erzwingen (Anlagen anlegen, Codes, Passwoerter,
 * Fernwartung, Image-Download).
 * @param {App.Locals} locals
 * @returns {App.User}
 */
export function requireOperator(locals) {
	const user = requireUser(locals);
	if (user.role !== 'operator') {
		error(403, 'Diese Aktion ist Betreibern vorbehalten.');
	}
	return user;
}

/** @param {App.Locals} locals */
export function isOperator(locals) {
	return locals.user?.role === 'operator';
}

const SESSION_DAYS = 30;

/** @param {string} token */
export function hashToken(token) {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Löst einen Einmal-Login-Token ein (markiert ihn als verbraucht).
 * @param {string} token
 * @returns {Promise<{tenant_id: number, member_id: number} | null>}
 */
export async function consumeLoginToken(token) {
	const rows = await sql`
		update login_token
		set used_at = now()
		where token_hash = ${hashToken(token)}
			and used_at is null
			and expires_at > now()
		returning tenant_id, member_id
	`;
	return /** @type {{tenant_id: number, member_id: number} | undefined} */ (rows[0]) ?? null;
}

/**
 * Legt eine Session an und gibt das Session-Token zurück.
 * @param {number} tenantId
 * @param {number} memberId
 */
export async function createSession(tenantId, memberId) {
	const token = randomBytes(32).toString('base64url');
	await sql`
		insert into session (tenant_id, member_id, token_hash, expires_at)
		values (${tenantId}, ${memberId}, ${hashToken(token)}, now() + ${`${SESSION_DAYS} days`}::interval)
	`;
	return token;
}

/**
 * @param {string} token
 * @returns {Promise<App.User | null>}
 */
export async function sessionUser(token) {
	const rows = await sql`
		select m.id as member_id, m.tenant_id, m.name, m.email, m.role,
			t.name as tenant_name, t.slug as tenant_slug
		from session s
		join member m on m.tenant_id = s.tenant_id and m.id = s.member_id
		join tenant t on t.id = m.tenant_id
		where s.token_hash = ${hashToken(token)} and s.expires_at > now()
	`;
	return /** @type {App.User | undefined} */ (rows[0]) ?? null;
}

/** @param {string} token */
export async function deleteSession(token) {
	await sql`delete from session where token_hash = ${hashToken(token)}`;
}
