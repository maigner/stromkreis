// Apple App Site Association fuer Universal Links der Stromkreis-App
// (Fork der openHAB-App, Bundle net.stromkreis.app, Team 6U7435AK45):
// https://stromkreis.net/app/setup/<token> oeffnet direkt die App.
// Muss ohne Redirect als application/json ausgeliefert werden.
import { json } from '@sveltejs/kit';

export const prerender = false;

/** @type {import('./$types').RequestHandler} */
export function GET() {
	return json({
		applinks: {
			details: [
				{
					appIDs: ['6U7435AK45.net.stromkreis.app'],
					components: [{ '/': '/app/setup/*' }, { '/': '/app/setup', '?': { token: '*' } }]
				}
			]
		}
	});
}
