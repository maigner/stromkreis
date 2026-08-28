import { json } from '@sveltejs/kit';
import {
	siteByToken,
	latestForecastRun,
	todayChargeWindow,
	individualChargeWindowEnd,
	chargeFactorsToday,
	todayDischargeStart,
	fleetDischargeKw
} from '$lib/server/gateway-data.js';

/**
 * Ladesperre-Fenster fuer eine Anlage (api/ladefenster.js im Gateway-Paket),
 * abgeleitet aus der Tagesprognose des Mandanten: morgens die PV der
 * Gemeinschaft ueberlassen, die Batterie erst aus dem Mittags-Ueberschuss
 * laden. Body: { "token": "<geheim>", "individuell": true|false }.
 *
 * Das Ende wird individualisiert, sobald die Anlage belastbare Schaetzwerte
 * gemeldet hat (batterie_kapazitaet, ladeleistung_kw): rueckwaerts von der
 * Abend-Deadline ueber das Erzeugungsprofil des Prognosetags, fuer die
 * Energie, die der zuletzt gemeldete Ladestand bis 95% noch braucht.
 * `ende` null bei individuell=true heisst: heute keine Sperre - das gilt
 * auch fuer Anlagen ohne gelernte Kennwerte (erst einmal ungebremst laden).
 * Mit individuell=false (Stromkreis_LADESPERRE_LOKAL=OFF am Gateway) kommt
 * das Gemeinschaftsfenster.
 *
 * Ausserdem: `entladestart` (ab wann die Nachteinspeisung heute beginnen
 * soll) und `ladefaktoren` (stuendliche Faktoren samt Abend-Deadline fuer
 * die dynamische Laderegelung).
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'JSON erwartet' }, { status: 400 });
	}
	const site = await siteByToken(body?.token);
	if (!site) return json({ error: 'Unbekannter Token.' }, { status: 401 });

	const run = await latestForecastRun(site.tenant_id);
	if (!run) return json({ error: 'Es liegt keine Energieprognose vor' }, { status: 404 });

	const fenster = await todayChargeWindow(site.tenant_id, Number(run.id));
	if (!fenster) return json({ error: 'Für heute liegt keine Energieprognose vor' }, { status: 404 });

	const individualisieren = body?.individuell !== false;
	const capacity = Number(site.status?.batterie_kapazitaet);
	const rate = Number(site.status?.ladeleistung_kw);
	const plausibel =
		Number.isFinite(capacity) && capacity >= 1 && capacity <= 100 &&
		Number.isFinite(rate) && rate >= 0.3 && rate <= 30;
	const socRaw = Number(site.status?.soc);
	const soc = Number.isFinite(socRaw) ? socRaw : null;
	let ende = fenster.ende;
	let individuell = false;

	if (individualisieren && fenster.start && fenster.ende) {
		if (plausibel) {
			const individualEnde = await individualChargeWindowEnd(
				site.tenant_id, Number(run.id), capacity, rate, soc
			);
			// Ende vor Fensterbeginn (oder gar nicht erreichbar): keine Sperre.
			ende = individualEnde !== null && individualEnde > fenster.start && individualEnde >= '05:00'
				? individualEnde
				: null;
		} else {
			// Noch keine gelernten Kennwerte: erst einmal laden, keine Sperre.
			ende = null;
		}
		individuell = true;
	}

	const ladefaktoren = await chargeFactorsToday(site.tenant_id, Number(run.id));
	const entladestart = await todayDischargeStart(
		site.tenant_id, Number(run.id), await fleetDischargeKw(site.tenant_id)
	);

	return json({
		ladefenster: {
			datum: fenster.datum,
			start: fenster.start,
			ende,
			individuell,
			entladestart,
			ladefaktoren
		}
	});
}
