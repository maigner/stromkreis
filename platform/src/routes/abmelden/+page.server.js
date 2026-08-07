import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth.js';

/** @type {import('./$types').Actions} */
export const actions = {
	default: async ({ cookies }) => {
		const token = cookies.get('session');
		if (token) {
			await deleteSession(token);
			cookies.delete('session', { path: '/' });
		}
		redirect(303, '/');
	}
};
