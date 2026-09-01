<script>
	let { data } = $props();

	const dateFmt = new Intl.DateTimeFormat('de-AT', {
		timeZone: 'Europe/Vienna',
		dateStyle: 'medium'
	});
</script>

<svelte:head>
	<title>Stromkreis-App einrichten | Stromkreis</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-16">
		<header>
			<h1 class="text-3xl font-bold tracking-tight">Stromkreis-App einrichten</h1>
			{#if data.valid && data.expires_at}
				<p class="mt-1 text-stone-600 dark:text-stone-400">
					Anlage {data.site_name} · Link gültig bis {dateFmt.format(new Date(data.expires_at))}
				</p>
			{/if}
		</header>

		{#if data.valid}
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<ol class="flex list-decimal flex-col gap-3 pl-5 text-sm text-stone-700 dark:text-stone-300">
					<li>
						Die Stromkreis-App auf dem Smartphone installieren (App Store bzw. Google Play).
					</li>
					<li>
						Auf dem Smartphone: unten auf <strong>In der App öffnen</strong> tippen.
						Die App richtet die Verbindung dann automatisch ein.
					</li>
					<li>
						Am Computer: den QR-Code unten mit der App scannen
						(beim ersten Start, oder später über die Einstellungen).
					</li>
				</ol>
				<a
					href={data.app_link}
					class="mt-5 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
				>
					In der App öffnen
				</a>
				<div class="mt-6 flex justify-center">
					<div class="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 dark:ring-stone-700">
						<div class="h-52 w-52 [&_svg]:h-full [&_svg]:w-full">
							{@html data.qr}
						</div>
					</div>
				</div>
				<p class="mt-4 text-xs text-stone-500 dark:text-stone-400">
					Der Code funktioniert genau einmal. Sobald die App eingerichtet ist, wird er ungültig.
				</p>
			</section>
		{:else}
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<p class="text-sm text-stone-700 dark:text-stone-300">
					Dieser Einrichtungslink ist ungültig, abgelaufen oder wurde bereits verwendet.
				</p>
				<p class="mt-2 text-sm text-stone-500 dark:text-stone-400">
					Bitte bei deiner Energiegemeinschaft einen neuen Einrichtungscode anfordern.
				</p>
			</section>
		{/if}
	</main>
</div>
