<script>
	import SiteMap from './SiteMap.svelte';
	import SetupWizard from './SetupWizard.svelte';
	import SyncStatus from './SyncStatus.svelte';
	import NewSiteForm from './NewSiteForm.svelte';
	import EnergieTab from './EnergieTab.svelte';
	import { profileLabels, de, seenLabel, watt, batteryLabel, gridLabel } from './site-format.js';

	let { data } = $props();

	// Aktiver Tab kommt aus der URL (?tab=), siehe +page.server.js
	const tab = $derived(data.tab);
	const tabs = [
		{ key: 'anlagen', label: 'Anlagen' },
		{ key: 'standorte', label: 'Standorte' },
		{ key: 'energie', label: 'Energie' },
		{ key: 'einrichtung', label: 'Neue Anlage' }
	];
	let showNewSite = $state(false);

	const roleLabels = { member: 'Mitglied', board: 'Vorstand', operator: 'Betreiber' };
</script>

<svelte:head>
	<title>{data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-16">
		<header class="flex items-start justify-between gap-4">
			<div>
				<p class="text-sm font-medium tracking-wide text-brand-600 uppercase dark:text-brand-500">
					{data.user.tenant_name}
				</p>
				<h1 class="text-3xl font-bold tracking-tight">Hallo, {data.user.name}</h1>
				<p class="mt-1 text-stone-600 dark:text-stone-400">
					Angemeldet als {roleLabels[data.user.role]}
					{#if data.canSwitch}
						· <a href="/intern/eeg-wechsel" class="text-brand-600 hover:underline dark:text-brand-500">EEG wechseln</a>
					{/if}
				</p>
			</div>
			<form method="POST" action="/abmelden">
				<button
					class="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
				>
					Abmelden
				</button>
			</form>
		</header>

		{#if data.sync}
			<SyncStatus job={data.sync} />
		{/if}

		<nav class="flex gap-6 border-b border-stone-200 dark:border-stone-800" aria-label="Bereiche">
			{#each tabs as t (t.key)}
				<a
					href="?tab={t.key}"
					data-sveltekit-noscroll
					class="-mb-px border-b-2 pb-2 text-sm font-medium {tab === t.key
						? 'border-brand-500 text-stone-900 dark:text-stone-100'
						: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
				>
					{t.label}
				</a>
			{/each}
		</nav>

		{#if tab === 'anlagen'}
		<section>
			<h2 class="sr-only">Anlagen</h2>
			<div class="flex flex-wrap items-center justify-end gap-3">
				{#if data.sites.length > 0 && !showNewSite}
					<button
						class="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
						onclick={() => (showNewSite = true)}
					>
						Neue Anlage für ein Mitglied
					</button>
				{/if}
			</div>

			{#if data.sites.length === 0}
				<p class="mt-4 text-sm text-stone-500 dark:text-stone-400">
					Noch keine Anlagen angebunden. Lege die erste Anlage für ein Mitglied an; Mitglieder und Zählpunkte kommen aus dem EEGFaktura-Import.
				</p>
				<div class="mt-4">
					<NewSiteForm members={data.members} />
				</div>
			{:else}
				{#if showNewSite}
					<div class="mt-4">
						<NewSiteForm members={data.members} onclose={() => (showNewSite = false)} />
					</div>
				{/if}
				<div class="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{#each data.sites as site (site.id)}
						<a
							href="/intern/anlagen/{site.id}"
							class="block rounded-lg border border-stone-200 bg-white p-4 transition-colors hover:border-brand-500 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-brand-500 {site.online ? '' : 'opacity-75'}"
						>
							<div class="flex items-center justify-between gap-2">
								<h3 class="font-semibold">{site.name}</h3>
								<span class="flex items-center gap-1.5 text-xs {site.online ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500'}">
									<span class="inline-block h-2 w-2 rounded-full {site.online ? 'bg-green-500' : 'bg-red-500'}"></span>
									{site.online ? 'Online' : 'Offline'}
								</span>
							</div>
							<p class="mt-0.5 text-sm text-stone-600 dark:text-stone-400">
								{site.member_name ?? 'Ohne Mitglied'} · {profileLabels[site.inverter_profile] ?? site.inverter_profile}
							</p>
							{#if site.address}
								<p class="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{site.address}</p>
							{/if}
							{#if site.setup_phase !== 'fertig' && !site.last_seen_at}
								<p class="mt-2 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-300">
									Einrichtung: {site.setup_label}{site.provision_code ? ` · Code ${site.provision_code}` : ''}
								</p>
							{:else}
								<p class="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
									openHABian {site.status.openhabian_version ?? '?'} · openHAB {site.status.openhab_version ?? '?'} · {seenLabel(site)}
								</p>
							{/if}

							{#if typeof site.status.soc === 'number'}
								<div class="mt-3">
									<div class="flex justify-between text-xs text-stone-600 dark:text-stone-400">
										<span>Ladestand</span>
										<span>{Math.round(site.status.soc)}%{typeof site.status.batterie_kapazitaet === 'number' ? ` von ${de(site.status.batterie_kapazitaet)} kWh` : ''}</span>
									</div>
									<div class="mt-1 h-2 rounded-full bg-stone-200 dark:bg-stone-800">
										<div
											class="h-2 rounded-full {site.status.soc > 25 ? 'bg-green-500' : 'bg-amber-500'}"
											style="width: {Math.min(100, Math.max(0, site.status.soc))}%"
										></div>
									</div>
								</div>
							{/if}

							<dl class="mt-3 grid grid-cols-3 gap-2 text-xs">
								<div>
									<dt class="text-stone-500 dark:text-stone-400">PV</dt>
									<dd class="mt-0.5 font-medium">{watt(site.status.pv_power_w) ?? 'k.A.'}</dd>
								</div>
								<div>
									<dt class="text-stone-500 dark:text-stone-400">Batterie</dt>
									<dd class="mt-0.5 font-medium">{batteryLabel(site.status)}</dd>
								</div>
								<div>
									<dt class="text-stone-500 dark:text-stone-400">Netz</dt>
									<dd class="mt-0.5 font-medium">{gridLabel(site.status)}</dd>
								</div>
							</dl>

							{#if site.status.ladesperre_aktiv === 'ON'}
								<p class="mt-3 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-300">
									Ladesperre aktiv: Batterie wartet auf die Mittagsspitze
								</p>
							{/if}
						</a>
					{/each}
				</div>
			{/if}
		</section>
		{:else if tab === 'standorte'}
		<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="text-lg font-semibold">Standorte</h2>
				<div class="flex gap-4 text-xs text-stone-600 dark:text-stone-400">
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-full bg-green-600"></span>
						Online
					</span>
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-full bg-red-600"></span>
						Offline
					</span>
				</div>
			</div>
			<p class="mt-1 mb-4 text-sm text-stone-600 dark:text-stone-400">
				Alle Anlagen der Gemeinschaft auf der Karte
			</p>
			{#if data.sites.some((s) => s.latitude != null && s.longitude != null)}
				<SiteMap sites={data.sites} center={data.center} />
			{:else}
				<p class="text-sm text-stone-500 dark:text-stone-400">Noch keine Anlagen mit Standort.</p>
			{/if}
		</section>
		{:else if tab === 'einrichtung'}
		<SetupWizard members={data.members} center={data.center} demo={data.demo} sites={data.sites} />
		{:else if data.energie}
		<EnergieTab energie={data.energie} sync={data.sync} />
		{/if}
	</main>
</div>
