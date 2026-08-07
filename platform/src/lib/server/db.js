import postgres from 'postgres';
import { env } from '$env/dynamic/private';

/** @type {import('postgres').Sql | undefined} */
let client;

function getClient() {
	if (!client) {
		if (!env.DATABASE_URL) {
			throw new Error('DATABASE_URL ist nicht gesetzt');
		}
		client = postgres(env.DATABASE_URL, { onnotice: () => {} });
	}
	return client;
}

// Verbindet erst bei der ersten Query, damit die Build-Analyse
// (Import der Servermodule ohne DATABASE_URL) nicht scheitert.
/** @param {any[]} args */
function lazySql(...args) {
	const c = /** @type {any} */ (getClient());
	return c(...args);
}

export const sql = /** @type {import('postgres').Sql} */ (/** @type {unknown} */ (lazySql));
