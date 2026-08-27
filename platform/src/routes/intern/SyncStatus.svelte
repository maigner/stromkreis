<script>
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';

	/** @type {{ job: { id: number, phase: string, full_import: boolean, progress: Record<string, any>, error: string | null, requested_at: string, finished_at: string | null, heartbeat_at: string | null, data_first_day: string | null, data_last_day: string | null } }} */
	let { job } = $props();

	const running = $derived(['queued', 'masterdata', 'energy'].includes(job.phase));
	const labels = {
		queued: 'Import wartet auf den Worker',
		masterdata: 'Mitglieder und Zählpunkte werden geladen',
		energy: 'Energiedaten werden geladen',
		done: 'Import abgeschlossen',
		error: 'Import fehlgeschlagen'
	};
	const fmtDay = (/** @type {string | undefined} */ iso) =>
		iso ? new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' }) : '';
	const fmtTime = (/** @type {string | null} */ iso) =>
		iso ? new Date(iso).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' }) : '';

	const percent = $derived.by(() => {
		const p = job.progress;
		if (job.phase === 'done') return 100;
		if (job.phase === 'queued') return 0;
		if (job.phase === 'masterdata') return 5;
		if (p.period_begin && p.period_end && p.chunk_end) {
			const a = Date.parse(p.period_begin), b = Date.parse(p.period_end), c = Date.parse(p.chunk_end);
			if (b > a) return Math.max(5, Math.min(99, Math.round(5 + (95 * (c - a)) / (b - a))));
		}
		return 10;
	});

	// Laufende Importe: alle 10 s neu laden (der Worker meldet Fortschritt je Chunk)
	onMount(() => {
		if (!running) return;
		const t = setInterval(() => invalidateAll(), 10000);
		return () => clearInterval(t);
	});
</script>

<section
	class="rounded-lg border p-4 {job.phase === 'error'
		? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40'
		: running
			? 'border-brand-300 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40'
			: 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'}"
>
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="font-semibold">
			EEGFaktura-Import: {labels[/** @type {keyof typeof labels} */ (job.phase)] ?? job.phase}
		</h2>
		<span class="text-xs text-stone-500">
			{#if job.finished_at}
				abgeschlossen {fmtTime(job.finished_at)}
			{:else}
				angefordert {fmtTime(job.requested_at)}{job.heartbeat_at ? `, zuletzt aktiv ${fmtTime(job.heartbeat_at)}` : ''}
			{/if}
		</span>
	</div>
	{#if running || job.phase === 'done'}
		<div class="mt-3 h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
			<div class="h-2 rounded bg-brand-500 transition-all" style="width: {percent}%"></div>
		</div>
	{/if}
	<p class="mt-2 text-sm text-stone-700 dark:text-stone-300">
		{#if job.phase === 'error'}
			{job.error}
		{:else if job.phase === 'queued'}
			Der Import startet in Kürze. Zuerst kommen Mitglieder und Zählpunkte, danach die Energiedaten in Monatsschritten. Das darf dauern; die Seite aktualisiert sich von selbst.
		{:else if job.phase === 'masterdata'}
			{job.progress.members ?? 0} Mitglieder, {job.progress.points ?? 0} Zählpunkte bisher.
		{:else}
			{job.progress.members ?? 0} Mitglieder, {job.progress.points ?? 0} Zählpunkte,
			{Number(job.progress.rows ?? 0).toLocaleString('de-AT')} Messwerte
			{#if job.progress.period_begin}
				· Zuletzt aktualisiert: {fmtDay(job.progress.period_begin)} bis {fmtDay(job.progress.period_end)}{job.progress.chunk_end && running ? `, geladen bis ${fmtDay(job.progress.chunk_end)}` : ''}
			{/if}
			{#if job.data_first_day}
				· Datenbestand: {fmtDay(job.data_first_day)} bis {fmtDay(job.data_last_day ?? undefined)}
			{/if}
		{/if}
	</p>
</section>
