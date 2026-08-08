<script>
	import maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';

	/** @type {{ sites: any[], center: [number, number], linked?: boolean }} */
	let { sites, center, linked = true } = $props();

	/** @type {maplibregl.Map | undefined} */
	let map;
	/** @type {HTMLDivElement} */
	let container;

	onMount(() => {
		// OpenFreeMap: EU-gehostete OSM-Kacheln, kein API-Key, kein Tracking
		// (gleiche Wahl und gleiche maplibre-Version wie die
		// ISCHLSTROM-Mitgliederkarte)
		map = new maplibregl.Map({
			container,
			style: 'https://tiles.openfreemap.org/styles/liberty',
			center,
			zoom: 11.5,
			attributionControl: { compact: true },
			// Ein Finger scrollt die Seite weiter, erst zwei Finger bewegen
			// die Karte, sonst bleibt man am Handy in der Karte haengen
			cooperativeGestures: true,
			locale: {
				'CooperativeGesturesHandler.MobileHelpText': 'Karte mit zwei Fingern verschieben',
				'CooperativeGesturesHandler.WindowsHelpText': 'Karte mit Strg + Scrollen zoomen',
				'CooperativeGesturesHandler.MacHelpText': 'Karte mit ⌘ + Scrollen zoomen'
			}
		});
		map.addControl(new maplibregl.NavigationControl());

		const bounds = new maplibregl.LngLatBounds();
		let markers = 0;
		for (const site of sites) {
			if (site.latitude == null || site.longitude == null) {
				continue;
			}
			const marker = new maplibregl.Marker({ color: site.online ? '#16a34a' : '#dc2626' })
				.setLngLat([site.longitude, site.latitude])
				.addTo(map);
			if (linked) {
				// Hover zeigt eine Vorschau, Klick oeffnet die Detailansicht
				const popup = new maplibregl.Popup({
					closeButton: false,
					closeOnClick: false,
					offset: 38
				}).setText(
					`${site.name}${site.address ? `, ${site.address}` : ''} (${site.online ? 'online' : 'offline'})`
				);
				const el = marker.getElement();
				el.style.cursor = 'pointer';
				el.setAttribute('role', 'link');
				el.setAttribute('aria-label', `${site.name}: Details anzeigen`);
				el.addEventListener('mouseenter', () => {
					if (map) popup.setLngLat([site.longitude, site.latitude]).addTo(map);
				});
				el.addEventListener('mouseleave', () => popup.remove());
				el.addEventListener('click', (e) => {
					e.stopPropagation();
					goto(`/intern/anlagen/${site.id}`);
				});
			}
			bounds.extend([site.longitude, site.latitude]);
			markers++;
		}
		if (markers > 1) {
			map.fitBounds(bounds, { padding: 56, maxZoom: 13 });
		}
	});

	onDestroy(() => {
		map?.remove();
	});
</script>

<div
	bind:this={container}
	class="h-[60dvh] w-full overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800"
></div>

<style>
	/* maplibre-Popups haben weissen Hintergrund, erben aber die Textfarbe der
	   Seite; im Dunkelmodus waere das weiss auf weiss. Farben daher explizit. */
	:global(.maplibregl-popup-content) {
		color: #171717;
		font-size: 13px;
		line-height: 1.4;
		padding: 8px 12px;
	}
</style>
