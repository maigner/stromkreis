<script>
	let { data } = $props();

	const roleLabels = { member: 'Mitglied', board: 'Vorstand', operator: 'Betreiber' };
</script>

<svelte:head>
	<title>{data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
	<main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
		<header class="flex items-start justify-between gap-4">
			<div>
				<p class="text-sm font-medium tracking-wide text-amber-600 uppercase dark:text-amber-500">
					{data.user.tenant_name}
				</p>
				<h1 class="text-3xl font-bold tracking-tight">Hallo, {data.user.name}</h1>
				<p class="mt-1 text-neutral-600 dark:text-neutral-400">
					Angemeldet als {roleLabels[data.user.role]}
				</p>
			</div>
			<form method="POST" action="/abmelden">
				<button
					class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
				>
					Abmelden
				</button>
			</form>
		</header>

		<p class="text-neutral-600 dark:text-neutral-400">
			Hier entstehen Dashboards, Prognose und Batteriemanagement für deine Energiegemeinschaft.
		</p>
	</main>
</div>
