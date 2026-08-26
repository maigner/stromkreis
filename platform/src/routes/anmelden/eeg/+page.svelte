<script>
    let { data, form } = $props();
</script>

<svelte:head>
    <title>Energiegemeinschaft wählen · Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
    <main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-16">
        <h1 class="text-2xl font-semibold">Welche Energiegemeinschaft?</h1>
        <p class="text-sm text-stone-600 dark:text-stone-400">
            Dein EEGFaktura-Konto verwaltet mehrere Energiegemeinschaften. Wähle die EEG, mit der du in Stromkreis arbeiten möchtest. Du kannst später jederzeit wechseln.
        </p>
        {#if form?.error}
            <p class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{form.error}</p>
        {/if}
        <form method="POST" class="flex flex-col gap-3">
            {#each data.tenants as t (t.id)}
                <button
                    type="submit"
                    name="tenant_id"
                    value={t.id}
                    class="rounded-lg border border-stone-200 bg-white p-4 text-left hover:border-brand-500 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-brand-500"
                >
                    <span class="block font-medium">{t.name}</span>
                    <span class="block text-xs text-stone-500">Als Betreiber anmelden</span>
                </button>
            {/each}
        </form>
        <a href="/" class="text-sm text-brand-600 hover:underline dark:text-brand-500">Abbrechen</a>
    </main>
</div>
