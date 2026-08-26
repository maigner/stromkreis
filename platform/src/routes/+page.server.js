import { oidcEnabled } from '$lib/server/oidc.js';

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	return { oidc: oidcEnabled(), user: locals.user ? { name: locals.user.name, tenant_name: locals.user.tenant_name } : null };
}
