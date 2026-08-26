<script>
	import SiteMap from './SiteMap.svelte';
	import SetupWizard from './SetupWizard.svelte';
	import SyncStatus from './SyncStatus.svelte';
	import NewSiteForm from './NewSiteForm.svelte';
	import { profileLabels, de, seenLabel, watt, batteryLabel, gridLabel } from './site-format.js';

	let { data } = $props();

	/** @type {'anlagen' | 'standorte' | 'energie' | 'einrichtung'} */
	let tab = $state('anlagen');
	let showNewSite = $state(false);

	const roleLabels = { member: 'Mitglied', board: 'Vorstand', operator: 'Betreiber' };

	const days = $derived(data.days);
	// Letzter vollstaendiger Tag (der letzte Eintrag ist der laufende Tag)
	const gestern = $derived(days.length >= 2 ? days[days.length - 2] : null);

	const chartH = 190;
	const chartW = 720;
	const maxKwh = $derived(
		Math.max(1, ...days.map((d) => Math.max(d.total_consumption, d.total_production)))
	);
	const slotW = $derived(chartW / Math.max(days.length, 1));
	const barW = $derived(Math.min(18, slotW * 0.3));
	const y = (/** @type {number} */ kwh) => (kwh / maxKwh) * chartH;

	const pct = (/** @type {number} */ a, /** @type {number} */ b) =>
		b > 0 ? Math.round((a / b) * 100) : 0;
	const dayLabel = (/** @type {string} */ day) => `${Number(day.slice(8, 10))}.`;
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
			<button
				class="-mb-px border-b-2 pb-2 text-sm font-medium {tab === 'anlagen'
					? 'border-brand-500 text-stone-900 dark:text-stone-100'
					: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
				onclick={() => (tab = 'anlagen')}
			>
				Anlagen
			</button>
			<button
				class="-mb-px border-b-2 pb-2 text-sm font-medium {tab === 'standorte'
					? 'border-brand-500 text-stone-900 dark:text-stone-100'
					: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
				onclick={() => (tab = 'standorte')}
			>
				Standorte
			</button>
			<button
				class="-mb-px border-b-2 pb-2 text-sm font-medium {tab === 'energie'
					? 'border-brand-500 text-stone-900 dark:text-stone-100'
					: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
				onclick={() => (tab = 'energie')}
			>
				Energie
			</button>
			<button
				class="-mb-px border-b-2 pb-2 text-sm font-medium {tab === 'einrichtung'
					? 'border-brand-500 text-stone-900 dark:text-stone-100'
					: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
				onclick={() => (tab = 'einrichtung')}
			>
				Neue Anlage
			</button>
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
		{:else}
		{#if gestern}
			<section class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
					<p class="text-sm text-stone-500 dark:text-stone-400">Verbrauch gestern</p>
					<p class="mt-1 text-2xl font-semibold">{de(gestern.total_consumption)} kWh</p>
				</div>
				<div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
					<p class="text-sm text-stone-500 dark:text-stone-400">Erzeugung gestern</p>
					<p class="mt-1 text-2xl font-semibold">{de(gestern.total_production)} kWh</p>
				</div>
				<div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
					<p class="text-sm text-stone-500 dark:text-stone-400">Eigendeckung gestern</p>
					<p class="mt-1 text-2xl font-semibold">{de(gestern.self_use)} kWh</p>
					<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
						{pct(gestern.self_use, gestern.total_production)}% der Erzeugung
					</p>
				</div>
				<div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
					<p class="text-sm text-stone-500 dark:text-stone-400">Autarkie gestern</p>
					<p class="mt-1 text-2xl font-semibold">{pct(gestern.self_use, gestern.total_consumption)}%</p>
					<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
						Verbrauch aus der Gemeinschaft gedeckt
					</p>
				</div>
			</section>
		{/if}

		<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="text-lg font-semibold">Letzte 14 Tage</h2>
				<div class="flex gap-4 text-xs text-stone-600 dark:text-stone-400">
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-sm bg-stone-400 dark:bg-stone-500"></span>
						Verbrauch
					</span>
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500"></span>
						Eigendeckung
					</span>
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-200 dark:bg-brand-300/60"></span>
						Überschuss
					</span>
				</div>
			</div>

			{#if days.length === 0}
				<p class="mt-4 text-sm text-stone-500 dark:text-stone-400">Noch keine Messdaten vorhanden.</p>
			{:else}
				<svg viewBox="0 0 {chartW} {chartH + 26}" class="mt-4 w-full" role="img" aria-label="Tagessummen der letzten 14 Tage">
					{#each [0.5, 1] as frac (frac)}
						<line
							x1="0"
							x2={chartW}
							y1={chartH - frac * chartH}
							y2={chartH - frac * chartH}
							class="stroke-stone-200 dark:stroke-stone-800"
							stroke-dasharray="3 4"
						/>
						<text
							x="2"
							y={chartH - frac * chartH - 4}
							class="fill-stone-400 text-[10px] dark:fill-stone-500"
						>
							{de(maxKwh * frac, 0)} kWh
						</text>
					{/each}
					{#each days as d, i (d.day)}
						{@const cx = i * slotW + slotW / 2}
						<!-- Verbrauch -->
						<rect
							x={cx - barW - 1.5}
							y={chartH - y(d.total_consumption)}
							width={barW}
							height={y(d.total_consumption)}
							rx="1.5"
							class="fill-stone-400 dark:fill-stone-500"
						/>
						<!-- Erzeugung: Eigendeckung unten, Ueberschuss oben -->
						<rect
							x={cx + 1.5}
							y={chartH - y(d.self_use)}
							width={barW}
							height={y(d.self_use)}
							rx="1.5"
							class="fill-brand-500"
						/>
						<rect
							x={cx + 1.5}
							y={chartH - y(d.self_use) - y(d.overshoot)}
							width={barW}
							height={y(d.overshoot)}
							rx="1.5"
							class="fill-brand-200 dark:fill-brand-300/60"
						/>
						<text
							x={cx}
							y={chartH + 16}
							text-anchor="middle"
							class="fill-stone-500 text-[10px] dark:fill-stone-400"
						>
							{dayLabel(d.day)}
						</text>
					{/each}
					<line x1="0" x2={chartW} y1={chartH} y2={chartH} class="stroke-stone-300 dark:stroke-stone-700" />
				</svg>
			{/if}
		</section>
		{/if}
	</main>
</div>
