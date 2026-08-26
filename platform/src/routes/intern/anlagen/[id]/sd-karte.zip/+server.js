import { error, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db.js';
import { platformBaseUrl, renderOpenhabianConf, renderProvisionConf, renderReadme } from '$lib/server/gateway-provision.js';
import { buildZip } from '$lib/server/zip.js';

// Download der SD-Karten-Dateien einer Anlage (Zip mit openhabian.conf,
// stromkreis-provision.conf, README.txt). Nur fuer angemeldete Betreiber des
// Mandanten; der Code wird bei Bedarf erneuert (abgelaufen oder fehlend).
export async function GET({ params, locals }) {
	if (!locals.user) throw redirect(303, '/');
	const [site] = await sql`
		select b.id, b.name, b.provision_code, b.provision_expires_at, b.status, t.name as tenant_name, t.slug
		from battery_site b join tenant t on t.id = b.tenant_id
		where b.tenant_id = ${locals.user.tenant_id} and b.id = ${Number(params.id)}`;
	if (!site) throw error(404, 'Anlage nicht gefunden');
	if (!site.provision_code || !site.provision_expires_at || site.provision_expires_at < new Date()) {
		throw error(409, 'Kein gueltiger Einrichtungscode; bitte im Dashboard einen neuen Code erzeugen');
	}
	const st = site.status ?? {};
	const hostname = `stromkreis-${site.slug}-${site.id}`.replace(/[^a-z0-9-]/g, '-').slice(0, 63);
	const files = [
		{ name: 'openhabian.conf', content: renderOpenhabianConf({ hostname, userPassword: st.linux_password || 'openhabian', wifiSsid: st.wifi_ssid, wifiPassword: st.wifi_password }) },
		{ name: 'stromkreis-provision.conf', content: renderProvisionConf({ code: site.provision_code, baseUrl: platformBaseUrl() }) },
		{ name: 'README.txt', content: renderReadme({ name: site.name, code: site.provision_code, expires: site.provision_expires_at, tenantName: site.tenant_name }) }
	];
	const zip = buildZip(files);
	return new Response(Buffer.from(zip), {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="sd-${site.slug}-${site.id}.zip"`,
			'Cache-Control': 'no-store'
		}
	});
}
