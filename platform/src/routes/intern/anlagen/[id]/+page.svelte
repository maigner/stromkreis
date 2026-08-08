<script>
	import SiteMap from '../../SiteMap.svelte';
	import { profileLabels, de, seenLabel, watt, batteryLabel, gridLabel } from '../../site-format.js';

	let { data } = $props();

	const site = $derived(data.site);
	const status = $derived(data.site.status);

	const dateFmt = new Intl.DateTimeFormat('de-AT', {
		timeZone: 'Europe/Vienna',
		dateStyle: 'medium',
		timeStyle: 'short'
	});
</script>

<svelte:head>
	<title>{site.name} | {data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
	<main class="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-16">
		<header>
			<a
				href="/intern"
				class="text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
			>
				&larr; Zur Übersicht
			</a>
			<div class="mt-2 flex flex-wrap items-center gap-3">
				<h1 class="text-3xl font-bold tracking-tight">{site.name}</h1>
				<span class="flex items-center gap-1.5 text-sm {site.online ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500'}">
					<span class="inline-block h-2.5 w-2.5 rounded-full {site.online ? 'bg-green-500' : 'bg-red-500'}"></span>
					{site.online ? 'Online' : 'Offline'}
				</span>
			</div>
			<p class="mt-1 text-neutral-600 dark:text-neutral-400">
				{site.member_name ?? 'Ohne Mitglied'} · {profileLabels[site.inverter_profile] ?? site.inverter_profile}{site.address ? ` · ${site.address}` : ''}
			</p>
			<p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
				Letzter Status-Push: {seenLabel(site)}{site.last_seen_at ? ` (${dateFmt.format(new Date(site.last_seen_at))})` : ''}
			</p>
		</header>

		{#if !site.online}
			<p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
				Keine Meldung seit über 10 Minuten. Die Werte unten stammen vom letzten Status-Push und können veraltet sein.
			</p>
		{/if}

		<div class="grid gap-4 md:grid-cols-2">
			<section class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
				<h2 class="text-lg font-semibold">Batterie</h2>
				{#if typeof status.soc === 'number'}
					<div class="mt-3">
						<div class="flex justify-between text-sm text-neutral-600 dark:text-neutral-400">
							<span>Ladestand</span>
							<span>{Math.round(status.soc)}% von {de(status.batterie_kapazitaet ?? 0)} kWh</span>
						</div>
						<div class="mt-1.5 h-3 rounded-full bg-neutral-200 dark:bg-neutral-800">
							<div
								class="h-3 rounded-full {status.soc > 25 ? 'bg-green-500' : 'bg-amber-500'}"
								style="width: {Math.min(100, Math.max(0, status.soc))}%"
							></div>
						</div>
					</div>
				{:else}
					<p class="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Kein Ladestand gemeldet.</p>
				{/if}
				<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
					<dt class="text-neutral-500 dark:text-neutral-400">Kapazität</dt>
					<dd class="font-medium">{typeof status.batterie_kapazitaet === 'number' ? `${de(status.batterie_kapazitaet)} kWh` : 'k.A.'}</dd>
					<dt class="text-neutral-500 dark:text-neutral-400">Entladegrenze</dt>
					<dd class="font-medium">{typeof status.min_battery_charge === 'number' ? `${status.min_battery_charge}%` : 'k.A.'}</dd>
					<dt class="text-neutral-500 dark:text-neutral-400">Ladesperre</dt>
					<dd class="font-medium">{status.ladesperre_aktiv === 'ON' ? 'Aktiv' : 'Inaktiv'}</dd>
				</dl>
				{#if status.ladesperre_aktiv === 'ON'}
					<p class="mt-3 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
						Ladesperre aktiv: Batterie wartet auf die Mittagsspitze
					</p>
				{/if}
			</section>

			<section class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
				<h2 class="text-lg font-semibold">Leistung</h2>
				<dl class="mt-3 grid grid-cols-2 gap-3">
					<div class="rounded-md bg-neutral-50 p-3 dark:bg-neutral-800/60">
						<dt class="text-xs text-neutral-500 dark:text-neutral-400">PV-Erzeugung</dt>
						<dd class="mt-1 text-lg font-semibold">{watt(status.pv_power_w) ?? 'k.A.'}</dd>
					</div>
					<div class="rounded-md bg-neutral-50 p-3 dark:bg-neutral-800/60">
						<dt class="text-xs text-neutral-500 dark:text-neutral-400">Hausverbrauch</dt>
						<dd class="mt-1 text-lg font-semibold">{watt(status.load_power_w) ?? 'k.A.'}</dd>
					</div>
					<div class="rounded-md bg-neutral-50 p-3 dark:bg-neutral-800/60">
						<dt class="text-xs text-neutral-500 dark:text-neutral-400">Batterie</dt>
						<dd class="mt-1 text-lg font-semibold">{batteryLabel(status)}</dd>
					</div>
					<div class="rounded-md bg-neutral-50 p-3 dark:bg-neutral-800/60">
						<dt class="text-xs text-neutral-500 dark:text-neutral-400">Netz</dt>
						<dd class="mt-1 text-lg font-semibold">{gridLabel(status)}</dd>
					</div>
				</dl>
			</section>

			<section class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 md:col-span-2">
				<h2 class="text-lg font-semibold">Gateway</h2>
				<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
					<div>
						<dt class="text-neutral-500 dark:text-neutral-400">openHABian</dt>
						<dd class="mt-0.5 font-medium">{status.openhabian_version ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-neutral-500 dark:text-neutral-400">openHAB</dt>
						<dd class="mt-0.5 font-medium">{status.openhab_version ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-neutral-500 dark:text-neutral-400">Wechselrichter</dt>
						<dd class="mt-0.5 font-medium">{status.inverter_status === 'running' ? 'Läuft' : status.inverter_status ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-neutral-500 dark:text-neutral-400">Hauptschalter</dt>
						<dd class="mt-0.5 font-medium">{status.hauptschalter === 'ON' ? 'Ein' : status.hauptschalter === 'OFF' ? 'Aus' : 'k.A.'}</dd>
					</div>
				</dl>
			</section>
		</div>

		{#if site.latitude != null && site.longitude != null}
			<section class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
				<h2 class="text-lg font-semibold">Standort</h2>
				{#if site.address}
					<p class="mt-1 mb-4 text-sm text-neutral-600 dark:text-neutral-400">{site.address}</p>
				{:else}
					<div class="mb-4"></div>
				{/if}
				<SiteMap sites={[site]} center={[site.longitude, site.latitude]} />
			</section>
		{/if}
	</main>
</div>
