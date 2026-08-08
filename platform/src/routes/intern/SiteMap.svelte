<script>
	import maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, onDestroy } from 'svelte';

	/** @type {{ sites: any[], center: [number, number] }} */
	let { sites, center } = $props();

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
			new maplibregl.Marker({ color: site.online ? '#16a34a' : '#dc2626' })
				.setLngLat([site.longitude, site.latitude])
				.setPopup(
					new maplibregl.Popup().setText(
						`${site.name}${site.address ? `, ${site.address}` : ''} (${site.online ? 'online' : 'offline'})`
					)
				)
				.addTo(map);
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
