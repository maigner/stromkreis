<script>
	let { data, form } = $props();
	const invalid = $derived(data.invalid || form?.invalid);
</script>

<svelte:head>
	<title>Anmeldung | Stromkreis</title>
</svelte:head>

<main class="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6 py-16">
	{#if invalid}
		<h1 class="text-2xl font-bold tracking-tight">Anmeldelink ungültig</h1>
		<p class="text-stone-600 dark:text-stone-400">
			Dieser Anmeldelink ist abgelaufen oder wurde bereits verwendet. Bitte fordere beim Betreiber
			deiner Energiegemeinschaft einen neuen Link an.
		</p>
		<p><a href="/" class="font-medium text-brand-600 hover:underline dark:text-brand-500">Zur Startseite</a></p>
	{:else}
		<h1 class="text-2xl font-bold tracking-tight">Anmelden bei Stromkreis</h1>
		<p class="text-stone-600 dark:text-stone-400">
			Der Anmeldelink ist gültig. Mit dem Knopf wird er einmalig eingelöst und du bist 30 Tage auf diesem
			Gerät angemeldet.
		</p>
		<form method="POST">
			<button class="rounded-md bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">Jetzt anmelden</button>
		</form>
	{/if}
</main>
