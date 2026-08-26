import { json } from '@sveltejs/kit';
import { consumeProvisionCode } from '$lib/server/gateway-provision.js';

// Erstkontakt des Gateways: POST {code} liefert die Konfiguration (ibm.conf-Schluessel)
// samt frischem Anlagen-Token. Bewusst POST, damit der Code nicht in Zugriffslogs landet.
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const code = typeof body?.code === 'string' ? body.code : '';
	const result = await consumeProvisionCode(code);
	if (!result) return json({ error: 'Einrichtungscode ungueltig oder abgelaufen' }, { status: 404 });
	return json({ config: result.config, anlage: { id: result.site.id, name: result.site.name, eeg: result.site.tenant_name } });
}
