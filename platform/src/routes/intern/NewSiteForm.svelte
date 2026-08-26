<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { profileLabels } from './site-format.js';

	/**
	 * Schnellanlage einer Anlage fuer ein importiertes Mitglied (Anlagen-Tab).
	 * Nur Mitglied und Wechselrichtertyp; Name, Adresse, Zaehlpunkt (Erzeugung des
	 * Mitglieds) und Standort (Gemeinschafts-Mittelpunkt) setzt der Server.
	 * Danach geht es mit dem Einrichtungscode weiter (SD-Karte, Assistent).
	 * @type {{ members: {id: number, name: string, participant_number?: string | null, address?: string | null, points: {id: number, metering_point: string, direction: string}[]}[], onclose?: () => void }}
	 */
	let { members, onclose } = $props();

	let memberId = $state('');
	let profile = $state('fronius-symo');
	let saving = $state(false);
	let error = $state('');
	let created = $state(/** @type {{id: number, code: string, expires: string} | null} */ (null));

	const selected = $derived(members.find((m) => String(m.id) === String(memberId)));
	const sortedMembers = $derived([...members].sort((a, b) => (a.participant_number ?? '').localeCompare(b.participant_number ?? '') || a.name.localeCompare(b.name)));

	/** @returns {(input: any) => Promise<void>} */
	function submit() {
		saving = true;
		error = '';
		return async ({ result }) => {
			saving = false;
			if (result.type === 'success' && result.data?.id) {
				created = /** @type {any} */ (result.data);
				await invalidateAll();
			} else if (result.type === 'failure') {
				error = result.data?.message ?? 'Bitte die Eingaben prüfen.';
			} else {
				error = 'Speichern fehlgeschlagen, bitte erneut versuchen.';
			}
		};
	}
	const fmtDate = (/** @type {string} */ iso) => new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' });

	const inputCls =
		'mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';
	const primaryBtn =
		'rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50';
	const secondaryBtn =
		'rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
</script>

<div class="rounded-lg border border-amber-300 bg-white p-5 dark:border-amber-700 dark:bg-neutral-900">
	{#if !created}
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 class="font-semibold">Neue Anlage für ein Mitglied</h3>
			{#if members.length === 0}
				<span class="text-xs text-neutral-500">Noch keine Mitglieder importiert; der EEGFaktura-Import läuft nach der Anmeldung im Hintergrund.</span>
			{/if}
		</div>
		<form method="POST" action="?/anlegen" use:enhance={submit} class="mt-4 grid gap-4 sm:grid-cols-2">
			<label class="block text-sm sm:col-span-2">
				<span class="text-neutral-600 dark:text-neutral-400">Mitglied (aus EEGFaktura)</span>
				<select name="member_id" bind:value={memberId} required class={inputCls}>
					<option value="" disabled>Mitglied wählen</option>
					{#each sortedMembers as m (m.id)}
						<option value={m.id}>
							{m.participant_number ? `${m.participant_number} · ` : ''}{m.name}{m.address ? ` · ${m.address}` : ''} ({m.points.length} ZP)
						</option>
					{/each}
				</select>
			</label>
			<label class="block text-sm">
				<span class="text-neutral-600 dark:text-neutral-400">Wechselrichtertyp</span>
				<select name="profile" bind:value={profile} required class={inputCls}>
					{#each Object.entries(profileLabels) as [value, label] (value)}
						<option {value}>{label}</option>
					{/each}
				</select>
			</label>
			{#if error}
				<p class="text-sm text-red-600 sm:col-span-2 dark:text-red-500">{error}</p>
			{/if}
			<div class="flex flex-wrap gap-3 sm:col-span-2">
				<button class={primaryBtn} disabled={saving || !selected}>{saving ? 'Wird angelegt ...' : 'Anlage anlegen'}</button>
				{#if onclose}
					<button type="button" class={secondaryBtn} onclick={onclose}>Abbrechen</button>
				{/if}
			</div>
		</form>
		<p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
			Name, Adresse und Zählpunkt kommen aus den Mitgliedsdaten, der Standort vom Gemeinschafts-Mittelpunkt; alles lässt sich in der Anlage anpassen. Für den ausführlichen Ablauf (Material, SD-Karte, Verbinden) gibt es den Tab "Neue Anlage".
		</p>
	{:else}
		<h3 class="font-semibold text-green-800 dark:text-green-400">Anlage für {selected?.name ?? 'das Mitglied'} ist angelegt.</h3>
		<p class="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
			Einrichtungscode <code class="rounded bg-neutral-100 px-2 py-0.5 font-mono tracking-widest dark:bg-neutral-950">{created.code}</code> (gültig bis {fmtDate(created.expires)}). Das fertige SD-Karten-Image mit diesem Code wird von der Plattform erstellt; das Gateway holt sich beim ersten Start seinen Zugangstoken selbst.
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/intern/anlagen/{created.id}" class={primaryBtn}>Zur Anlage</a>
			<button type="button" class={secondaryBtn} onclick={() => { created = null; memberId = ''; }}>Weitere Anlage</button>
		</div>
	{/if}
</div>
