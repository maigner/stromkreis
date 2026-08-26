<script>
	let { data } = $props();
</script>

<svelte:head>
	<title>Stromkreis | Plattform für Energiegemeinschaften</title>
	<meta
		name="description"
		content="Stromkreis ist die offene Plattform von Energiegemeinschaften für Energiegemeinschaften: Energiedaten aus EEG-Faktura, Prognosen und intelligentes Batteriemanagement. Gemeinnützig und quelloffen."
	/>
</svelte:head>

<div class="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
	<main class="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
		<header class="flex items-center gap-4">
			<svg viewBox="0 0 32 32" class="h-12 w-12 shrink-0" aria-hidden="true">
				<circle cx="16" cy="16" r="13" fill="none" stroke="#f59e0b" stroke-width="3" />
				<path fill="#f59e0b" d="M17.8 7.5 10.8 18h4.4l-1.6 6.5L20.8 14h-4.4z" />
			</svg>
			<div>
				<h1 class="text-4xl font-bold tracking-tight">Stromkreis</h1>
				<p class="text-sm font-medium tracking-wide text-amber-600 uppercase dark:text-amber-500">
					Im Aufbau
				</p>
			</div>
		</header>

		<div class="space-y-4">
			<p class="text-xl text-neutral-700 dark:text-neutral-300">
				Die offene Plattform von Energiegemeinschaften für Energiegemeinschaften.
			</p>
			<p class="text-neutral-600 dark:text-neutral-400">
				Energiedaten verständlich machen, die nahe Zukunft prognostizieren und Heimspeicher so
				steuern, dass sie der Gemeinschaft nützen.
			</p>
		</div>

		<section
			class="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-amber-700 dark:bg-amber-950/40"
		>
			<div>
				<h2 class="font-semibold">Für Betreiber von Energiegemeinschaften</h2>
				<p class="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
					{#if data.user}
						Du bist angemeldet bei {data.user.tenant_name}.
					{:else if data.oidc}
						Anmelden mit dem EEGFaktura-Konto deiner EEG. Nach der ersten Anmeldung holt Stromkreis
						Mitglieder, Zählpunkte und Energiedaten im Hintergrund aus EEGFaktura.
					{:else}
						Die Anmeldung erfolgt derzeit über persönliche Einladungslinks.
					{/if}
				</p>
			</div>
			{#if data.user}
				<a
					href="/intern"
					class="shrink-0 rounded-md bg-amber-500 px-4 py-2 text-center font-medium text-neutral-900 hover:bg-amber-400"
					>Zum Dashboard</a
				>
			{:else if data.oidc}
				<a
					href="/auth/eegfaktura/login"
					data-sveltekit-reload
					class="shrink-0 rounded-md bg-amber-500 px-4 py-2 text-center font-medium text-neutral-900 hover:bg-amber-400"
					>Anmelden mit EEGFaktura</a
				>
			{/if}
		</section>

		<div class="grid gap-4 sm:grid-cols-3">
			<section
				class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
			>
				<h2 class="font-semibold">Energiedaten</h2>
				<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
					Import aus EEG-Faktura, verständliche Dashboards für Mitglieder und Vorstand.
				</p>
			</section>
			<section
				class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
			>
				<h2 class="font-semibold">Prognose</h2>
				<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
					Wetterbasierte Energieprognose je Gemeinschaft, Prognose und Ist im Vergleich.
				</p>
			</section>
			<section
				class="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
			>
				<h2 class="font-semibold">Batteriemanagement</h2>
				<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
					Heimspeicher laden prognosegesteuert, wenn es der Gemeinschaft nützt. Fail-Safe von Anfang
					an.
				</p>
			</section>
		</div>

		<footer class="border-t border-neutral-200 pt-6 text-sm text-neutral-500 dark:border-neutral-800">
			Gemeinnützig und quelloffen (AGPL-3.0). Erprobt im Realbetrieb bei
			<a
				href="https://ischlstrom.org"
				class="font-medium text-amber-600 hover:underline dark:text-amber-500">ISCHLSTROM</a
			>.
		</footer>
	</main>
</div>
