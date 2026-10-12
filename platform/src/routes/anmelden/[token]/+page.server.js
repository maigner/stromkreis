import { redirect } from '@sveltejs/kit';
import { consumeLoginToken, createSession, peekLoginToken } from '$lib/server/auth.js';

// Einmal-Login-Link: GET zeigt nur die Anmeldeseite (der Link bleibt gueltig,
// Link-Scanner in Mailprogrammen entwerten ihn so nicht), erst der POST loest
// den Token ein und legt die Session an.

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
	return { invalid: !(await peekLoginToken(params.token)) };
}

/** @type {import('./$types').Actions} */
export const actions = {
	default: async ({ params, cookies }) => {
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
};
