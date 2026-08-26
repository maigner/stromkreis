<script>
    let { data, form } = $props();
</script>

<svelte:head>
    <title>Energiegemeinschaft wählen · Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-16">
        <h1 class="text-2xl font-semibold">Welche Energiegemeinschaft?</h1>
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
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
                    class="rounded-lg border border-neutral-200 bg-white p-4 text-left hover:border-amber-500 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-amber-500"
                >
                    <span class="block font-medium">{t.name}</span>
                    <span class="block text-xs text-neutral-500">Als Betreiber anmelden</span>
                </button>
            {/each}
        </form>
        <a href="/" class="text-sm text-amber-600 hover:underline dark:text-amber-500">Abbrechen</a>
    </main>
</div>
