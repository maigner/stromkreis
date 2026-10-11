import { requireUser } from '$lib/server/auth.js';

/** @type {import('./$types').LayoutServerLoad} */
export function load({ locals }) {
	// Ohne Session zur Startseite, Rolle member bekommt 403; Betreiber und
	// Vorstand kommen durch (die Rolle steht in data.user.role).
	return { user: requireUser(locals) };
}
