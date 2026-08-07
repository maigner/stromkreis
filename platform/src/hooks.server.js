import { sessionUser } from '$lib/server/auth.js';

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
	const token = event.cookies.get('session');
	event.locals.user = token ? await sessionUser(token) : null;
	return resolve(event);
}
