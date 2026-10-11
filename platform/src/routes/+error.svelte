<script>
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>Fehler {page.status} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6 py-16">
		<p class="text-sm text-stone-500 dark:text-stone-400">Fehler {page.status}</p>
		<h1 class="text-2xl font-bold tracking-tight">
			{#if page.status === 403}
				Kein Zugang
			{:else if page.status === 404}
				Seite nicht gefunden
			{:else}
				Etwas ist schiefgegangen
			{/if}
		</h1>
		<p class="text-stone-600 dark:text-stone-400">{page.error?.message ?? 'Unbekannter Fehler.'}</p>
		<div class="mt-2 flex gap-4 text-sm">
			<a href="/" class="text-brand-600 hover:underline dark:text-brand-500">Zur Startseite</a>
			{#if page.status === 403}
				<form method="POST" action="/abmelden">
					<button class="text-brand-600 hover:underline dark:text-brand-500">Abmelden</button>
				</form>
			{/if}
		</div>
	</main>
</div>
