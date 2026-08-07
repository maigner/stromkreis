import { redirect } from '@sveltejs/kit';
import { consumeLoginToken, createSession } from '$lib/server/auth.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params, cookies }) {
	const grant = await consumeLoginToken(params.token);
	if (!grant) {
		return { invalid: true };
	}
	const token = await createSession(grant.tenant_id, grant.member_id);
	cookies.set('session', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 30
	});
	redirect(303, '/intern');
}
