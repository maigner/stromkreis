import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db.js';

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
