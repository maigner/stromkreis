<script>
    let { data } = $props();
</script>

<svelte:head>
    <title>Anmeldung fehlgeschlagen · Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
    <main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-16">
        <h1 class="text-2xl font-semibold">Anmeldung fehlgeschlagen</h1>
        <p class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{data.grund}</p>
        <p class="text-sm text-stone-600 dark:text-stone-400">
            Die Anmeldung braucht ein EEGFaktura-Konto mit Administrator-Rechten (Gruppe EEG_ADMIN) für mindestens eine Energiegemeinschaft.
        </p>
        <a href="/auth/eegfaktura/login" class="rounded-md bg-brand-600 px-4 py-2 text-center font-medium text-white hover:bg-brand-700">Erneut versuchen</a>
        <a href="/" class="text-sm text-brand-600 hover:underline dark:text-brand-500">Zur Startseite</a>
    </main>
</div>
