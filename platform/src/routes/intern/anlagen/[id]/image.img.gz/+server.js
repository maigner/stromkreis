import { error, redirect } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { sql } from '$lib/server/db.js';
import { imageDownload } from '$lib/server/gateway-image.js';

/**
 * Download des fertigen SD-Karten-Images (site-<id>.img.gz), gebaut ueber
 * "Image erstellen" im Einrichtungs-Assistenten bzw. auf der Anlagenseite.
 * Mit dem Raspberry Pi Imager ("Eigenes Image") oder balenaEtcher auf die
 * Karte schreiben - Windows, macOS und Linux. Tenant-gescoped.
 */

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals, params }) {
	if (!locals.user) redirect(303, '/');
	const id = Number(params.id);
	const [site] = Number.isInteger(id)
		? await sql`select id, name from battery_site where tenant_id = ${locals.user.tenant_id} and id = ${id}`
		: [];
	if (!site) error(404, 'Anlage nicht gefunden');

	const download = await imageDownload(Number(site.id));
	if (!download) error(404, 'Kein Image gebaut - zuerst "Image erstellen".');

	const slug = String(site.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `anlage-${site.id}`;
	return new Response(/** @type {any} */ (Readable.toWeb(download.stream())), {
		headers: {
			'Content-Type': 'application/gzip',
			'Content-Length': String(download.size),
			'Content-Disposition': `attachment; filename="stromkreis-${slug}.img.gz"`,
			'Cache-Control': 'no-store'
		}
	});
}
