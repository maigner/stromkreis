<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	/**
	 * SD-Karten-Image einer Anlage: Bau anstossen, Fortschritt zeigen,
	 * fertiges Image herunterladen. Wird im Einrichtungs-Assistenten
	 * (Schritt "SD-Karte") und auf der Anlagenseite verwendet; der Zustand
	 * kommt aus getImageStatus() (gateway-image.js).
	 * @type {{ siteId: number, image: { building: { phase: string, startedAt: string } | null, other_building: boolean, image: { builtAt: string, size: number, stale: boolean } | null, error: { message: string, at: string } | null }, codeValid: boolean }}
	 */
	let { siteId, image, codeValid } = $props();

	let formError = $state('');
	const gb = (/** @type {number} */ n) => `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
	const fmtTime = (/** @type {string} */ iso) =>
		new Date(iso).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' });

	// Waehrend des Baus alle 5 s neu laden (der Fortschritt kommt vom Server)
	$effect(() => {
		if (!image.building) return;
		const t = setInterval(() => invalidateAll(), 5000);
		return () => clearInterval(t);
	});

	/** @returns {(input: any) => Promise<void>} */
	function submitBauen() {
		formError = '';
		return async ({ result }) => {
			if (result.type === 'failure') {
				formError = result.data?.message ?? 'Image-Bau fehlgeschlagen.';
			}
			await invalidateAll();
		};
	}

	const primaryBtn =
		'rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
	const secondaryBtn =
		'rounded-md border border-stone-300 px-4 py-2 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900';
</script>

<div class="flex flex-col gap-3">
	{#if image.building}
		<div class="flex items-center gap-3 rounded-md border border-brand-300 bg-brand-50 px-3 py-2.5 text-sm dark:border-brand-700 dark:bg-brand-950/40">
			<span class="h-4 w-4 flex-none animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true"></span>
			<span>
				Image wird gebaut: {image.building.phase} ... (seit {fmtTime(image.building.startedAt)}; beim ersten Mal
				lädt die Plattform zuerst das openHABian-Basis-Image, das dauert einige Minuten)
			</span>
		</div>
	{:else}
		{#if image.error}
			<p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
				Letzter Image-Bau fehlgeschlagen ({fmtTime(image.error.at)}): {image.error.message}
			</p>
		{/if}
		{#if image.image}
			<div class="flex flex-wrap items-center gap-3">
				<a href="/intern/anlagen/{siteId}/image.img.gz" class={primaryBtn} data-sveltekit-preload-data="off">
					Image herunterladen ({gb(image.image.size)})
				</a>
				<span class="text-xs text-stone-600 dark:text-stone-400">Stand {fmtTime(image.image.builtAt)}</span>
				<form method="POST" action="?/image_bauen" use:enhance={submitBauen}>
					<input type="hidden" name="site_id" value={siteId} />
					<button class={secondaryBtn} disabled={!codeValid}>Image neu erstellen</button>
				</form>
			</div>
			{#if image.image.stale}
				<p class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
					Das Image wurde mit einem älteren Einrichtungscode gebaut oder der Code ist abgelaufen; bitte neu erstellen.
				</p>
			{/if}
		{:else}
			<form method="POST" action="?/image_bauen" use:enhance={submitBauen}>
				<input type="hidden" name="site_id" value={siteId} />
				<button class={primaryBtn} disabled={!codeValid}>Image erstellen</button>
			</form>
		{/if}
		{#if image.other_building}
			<p class="text-xs text-stone-500 dark:text-stone-400">Es wird gerade ein anderes Image gebaut; bitte kurz warten.</p>
		{/if}
		{#if formError}
			<p class="text-sm text-red-600 dark:text-red-500">{formError}</p>
		{/if}
	{/if}
</div>
