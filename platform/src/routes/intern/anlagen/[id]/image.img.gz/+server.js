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
		? await sql`
				select b.id, b.name, mem.name as member_name
				from battery_site b
				left join member mem on mem.tenant_id = b.tenant_id and mem.id = b.member_id
				where b.tenant_id = ${locals.user.tenant_id} and b.id = ${id}`
		: [];
	if (!site) error(404, 'Anlage nicht gefunden');

	const download = await imageDownload(Number(site.id));
	if (!download) error(404, 'Kein Image gebaut - zuerst "Image erstellen".');

	// Dateiname: Anlage und Besitzer, damit mehrere Images im Download-Ordner
	// unterscheidbar bleiben; der Mitgliedsname entfaellt, wenn er schon im
	// Anlagennamen steckt (Standardname "Anlage <Mitglied>").
	const slugify = (/** @type {string} */ t) =>
		t.toLowerCase()
			.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
			.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	const parts = [String(site.name)];
	if (site.member_name && !String(site.name).toLowerCase().includes(String(site.member_name).toLowerCase())) {
		parts.push(String(site.member_name));
	}
	const slug = parts.map(slugify).filter(Boolean).join('-') || `anlage-${site.id}`;
	return new Response(/** @type {any} */ (Readable.toWeb(download.stream())), {
		headers: {
			'Content-Type': 'application/gzip',
			'Content-Length': String(download.size),
			'Content-Disposition': `attachment; filename="stromkreis-${slug}.img.gz"`,
			'Cache-Control': 'no-store'
		}
	});
}
