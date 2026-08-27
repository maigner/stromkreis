<script>
	import SiteMap from '../../SiteMap.svelte';
	import { profileLabels, de, seenLabel, watt, batteryLabel, gridLabel } from '../../site-format.js';

	let { data } = $props();

	const site = $derived(data.site);
	const status = $derived(data.site.status);
	const logs = $derived(Array.isArray(data.site.status.logs) ? data.site.status.logs : []);

	const dateFmt = new Intl.DateTimeFormat('de-AT', {
		timeZone: 'Europe/Vienna',
		dateStyle: 'medium',
		timeStyle: 'short'
	});
</script>

<svelte:head>
	<title>{site.name} | {data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-16">
		<header>
			<a
				href="/intern"
				class="text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
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
			<p class="mt-1 text-stone-600 dark:text-stone-400">
				{site.member_name ?? 'Ohne Mitglied'} · {profileLabels[site.inverter_profile] ?? site.inverter_profile}{site.address ? ` · ${site.address}` : ''}
			</p>
			<p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
				Letzter Status-Push: {seenLabel(site)}{site.last_seen_at ? ` (${dateFmt.format(new Date(site.last_seen_at))})` : ''}
			</p>
		</header>

		{#if !site.online}
			<p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
				Keine Meldung seit über 10 Minuten. Die Werte unten stammen vom letzten Status-Push und können veraltet sein.
			</p>
		{/if}

		{#if site.setup_phase !== 'fertig' || site.code_valid}
			<section class="rounded-lg border border-brand-300 bg-brand-50 p-5 dark:border-brand-700 dark:bg-brand-950/40">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 class="text-lg font-semibold">Einrichtung: {site.setup_label}</h2>
					<span class="text-xs text-stone-600 dark:text-stone-400">{site.setup_percent}%{site.setup_phase_at ? ` · ${dateFmt.format(new Date(site.setup_phase_at))}` : ''}</span>
				</div>
				<div class="mt-2 h-2 rounded-full bg-stone-200 dark:bg-stone-800">
					<div class="h-2 rounded-full {site.setup_phase === 'fertig' ? 'bg-green-500' : 'bg-brand-500'}" style="width: {site.setup_percent}%"></div>
				</div>
				{#if site.setup_message}
					<p class="mt-2 font-mono text-xs text-stone-700 dark:text-stone-300">{site.setup_message}</p>
				{/if}
				<div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
					{#if site.code_valid}
						<span>Einrichtungscode <code class="rounded bg-white px-2 py-0.5 font-mono tracking-widest dark:bg-stone-950">{site.provision_code}</code> gültig bis {new Date(site.provision_expires_at).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}</span>
						<span class="text-xs text-stone-600 dark:text-stone-400">SD-Karten-Image: Erstellung auf der Plattform in Arbeit</span>
					{:else}
						<span class="text-stone-600 dark:text-stone-400">Kein gültiger Einrichtungscode.</span>
					{/if}
					<form method="POST" action="?/code_erneuern">
						<button class="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900">Neuer Code</button>
					</form>
				</div>
				{#if site.metering_point}
					<p class="mt-3 text-xs text-stone-600 dark:text-stone-400">Zählpunkt: {site.point_direction === 'generation' ? 'Erzeugung' : 'Verbrauch'} {site.metering_point}</p>
				{/if}
			</section>
		{/if}

		<div class="grid gap-4 md:grid-cols-2">
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<h2 class="text-lg font-semibold">Batterie</h2>
				{#if typeof status.soc === 'number'}
					<div class="mt-3">
						<div class="flex justify-between text-sm text-stone-600 dark:text-stone-400">
							<span>Ladestand</span>
							<span>{Math.round(status.soc)}%{typeof status.batterie_kapazitaet === 'number' ? ` von ${de(status.batterie_kapazitaet)} kWh` : ''}</span>
						</div>
						<div class="mt-1.5 h-3 rounded-full bg-stone-200 dark:bg-stone-800">
							<div
								class="h-3 rounded-full {status.soc > 25 ? 'bg-green-500' : 'bg-amber-500'}"
								style="width: {Math.min(100, Math.max(0, status.soc))}%"
							></div>
						</div>
					</div>
				{:else}
					<p class="mt-3 text-sm text-stone-500 dark:text-stone-400">Kein Ladestand gemeldet.</p>
				{/if}
				<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
					<dt class="text-stone-500 dark:text-stone-400">Kapazität</dt>
					<dd class="font-medium">{typeof status.batterie_kapazitaet === 'number' ? `${de(status.batterie_kapazitaet)} kWh` : 'k.A.'}</dd>
					<dt class="text-stone-500 dark:text-stone-400">Entladegrenze</dt>
					<dd class="font-medium">{typeof status.min_battery_charge === 'number' ? `${status.min_battery_charge}%` : 'k.A.'}</dd>
					<dt class="text-stone-500 dark:text-stone-400">Ladesperre</dt>
					<dd class="font-medium">{status.ladesperre_aktiv === 'ON' ? 'Aktiv' : 'Inaktiv'}</dd>
				</dl>
				{#if status.ladesperre_aktiv === 'ON'}
					<p class="mt-3 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-300">
						Ladesperre aktiv: Batterie wartet auf die Mittagsspitze
					</p>
				{/if}
			</section>

			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<h2 class="text-lg font-semibold">Leistung</h2>
				<dl class="mt-3 grid grid-cols-2 gap-3">
					<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
						<dt class="text-xs text-stone-500 dark:text-stone-400">PV-Erzeugung</dt>
						<dd class="mt-1 text-lg font-semibold">{watt(status.pv_power_w) ?? 'k.A.'}</dd>
					</div>
					<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
						<dt class="text-xs text-stone-500 dark:text-stone-400">Hausverbrauch</dt>
						<dd class="mt-1 text-lg font-semibold">{watt(status.load_power_w) ?? 'k.A.'}</dd>
					</div>
					<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
						<dt class="text-xs text-stone-500 dark:text-stone-400">Batterie</dt>
						<dd class="mt-1 text-lg font-semibold">{batteryLabel(status)}</dd>
					</div>
					<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
						<dt class="text-xs text-stone-500 dark:text-stone-400">Netz</dt>
						<dd class="mt-1 text-lg font-semibold">{gridLabel(status)}</dd>
					</div>
				</dl>
			</section>

			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900 md:col-span-2">
				<h2 class="text-lg font-semibold">Gateway</h2>
				<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
					<div>
						<dt class="text-stone-500 dark:text-stone-400">openHABian</dt>
						<dd class="mt-0.5 font-medium">{status.openhabian_version ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-stone-500 dark:text-stone-400">openHAB</dt>
						<dd class="mt-0.5 font-medium">{status.openhab_version ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-stone-500 dark:text-stone-400">Wechselrichter</dt>
						<dd class="mt-0.5 font-medium">{status.inverter_status === 'running' ? 'Läuft' : status.inverter_status ?? 'k.A.'}</dd>
					</div>
					<div>
						<dt class="text-stone-500 dark:text-stone-400">Hauptschalter</dt>
						<dd class="mt-0.5 font-medium">{status.hauptschalter === 'ON' ? 'Ein' : status.hauptschalter === 'OFF' ? 'Aus' : 'k.A.'}</dd>
					</div>
				</dl>
			</section>
		</div>

		<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
			<h2 class="text-lg font-semibold">Protokoll</h2>
			<p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
				Letzte Zeilen aus openhab.log, übertragen mit dem Status-Push
			</p>
			{#if logs.length === 0}
				<p class="mt-4 text-sm text-stone-500 dark:text-stone-400">Keine Protokollzeilen übertragen.</p>
			{:else}
				<div class="mt-4 max-h-80 overflow-y-auto rounded-md bg-stone-950 p-3 font-mono text-xs leading-relaxed text-stone-300">
					{#each logs as line, i (i)}
						<p class="whitespace-pre-wrap">
							<span class="text-stone-500">{line.ts}</span>
							<span class={line.level === 'ERROR' ? 'text-red-400' : line.level === 'WARN' ? 'text-amber-400' : 'text-green-400'}>[{line.level}]</span>
							<span class="text-sky-400">[{line.logger}]</span>
							- {line.msg}
						</p>
					{/each}
				</div>
			{/if}
		</section>

		{#if site.latitude != null && site.longitude != null}
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<h2 class="text-lg font-semibold">Standort</h2>
				{#if site.address}
					<p class="mt-1 mb-4 text-sm text-stone-600 dark:text-stone-400">{site.address}</p>
				{:else}
					<div class="mb-4"></div>
				{/if}
				<SiteMap sites={[site]} center={[site.longitude, site.latitude]} />
			</section>
		{/if}
	</main>
</div>
