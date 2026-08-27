<script>
	import { de } from './site-format.js';

	/**
	 * Tab "Energie": importierte EEG-Faktura-Energiedaten des Mandanten fuer einen
	 * waehlbaren Zeitraum (Kennzahlen, Verlauf, Datenbestand).
	 * @type {{ energie: import('$lib/server/energie.js').loadEnergie extends (...a: any) => Promise<infer R> ? R : never, sync: any }}
	 */
	let { energie, sync } = $props();

	const series = $derived(energie.series);
	const totals = $derived(energie.totals);
	const hasData = $derived(totals.days > 0);

	const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b > 0 ? Math.round((a / b) * 100) : 0);
	const kwh = (/** @type {number} */ x) => (Math.abs(x) >= 10000 ? `${de(x / 1000)} MWh` : `${de(x, x >= 100 ? 0 : 1)} kWh`);
	const fmtDate = (/** @type {string | null} */ iso) =>
		iso ? new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'k.A.';
	const fmtDateTime = (/** @type {string | null} */ iso) =>
		iso ? new Date(iso).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'k.A.';

	// Diagramm: Verbrauch (grau) neben Erzeugung (Eigendeckung unten, Ueberschuss oben)
	const chartH = 190;
	const chartW = 720;
	const maxKwh = $derived(Math.max(1, ...series.map((d) => Math.max(d.total_consumption, d.total_production))));
	const slotW = $derived(chartW / Math.max(series.length, 1));
	const barW = $derived(Math.min(18, slotW * 0.32));
	const y = (/** @type {number} */ v) => (v / maxKwh) * chartH;
	// Beschriftung ausduennen, damit sich die Labels nicht ueberlagern
	const labelEvery = $derived(series.length > 40 ? 7 : series.length > 20 ? 3 : 1);

	const netzbezug = $derived(Math.max(0, totals.total_consumption - totals.self_use));

	const cardCls = 'rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900';
</script>

<section class="flex flex-wrap items-center justify-between gap-3">
	<h2 class="text-lg font-semibold">Energiedaten aus EEGFaktura</h2>
	<nav class="flex gap-1 rounded-md border border-stone-200 p-0.5 text-sm dark:border-stone-800" aria-label="Zeitraum">
		{#each energie.zeitraeume as z (z.key)}
			<a
				href="?tab=energie&zeitraum={z.key}"
				data-sveltekit-noscroll
				class="rounded px-3 py-1 {z.key === energie.zeitraum
					? 'bg-brand-500 text-white'
					: 'text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800'}"
			>
				{z.label}
			</a>
		{/each}
	</nav>
</section>

{#if !hasData}
	<section class={cardCls}>
		<p class="text-sm text-stone-600 dark:text-stone-400">
			{#if energie.coverage.first_at}
				Im gewählten Zeitraum liegen keine Messdaten vor. Vorhanden sind Daten von {fmtDate(energie.coverage.first_at)} bis {fmtDate(energie.coverage.last_at)}.
			{:else if sync && sync.phase !== 'done' && sync.phase !== 'error'}
				Der Import aus EEGFaktura läuft noch; die Energiedaten erscheinen hier, sobald die ersten Stücke geladen sind.
			{:else}
				Noch keine Messdaten vorhanden. Die Energiedaten kommen mit dem Import aus EEGFaktura.
			{/if}
		</p>
	</section>
{:else}
	<section class="grid grid-cols-2 gap-4 lg:grid-cols-4">
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Verbrauch</p>
			<p class="mt-1 text-2xl font-semibold">{kwh(totals.total_consumption)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">davon Netzbezug {kwh(netzbezug)}</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Gemeinschaftliche Erzeugung</p>
			<p class="mt-1 text-2xl font-semibold">{kwh(totals.total_production)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Überschuss ins Netz {kwh(totals.overshoot)}</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Eigendeckung</p>
			<p class="mt-1 text-2xl font-semibold">{kwh(totals.self_use)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">{pct(totals.self_use, totals.total_production)}% der Erzeugung in der Gemeinschaft verbraucht</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Autarkie</p>
			<p class="mt-1 text-2xl font-semibold">{pct(totals.self_use, totals.total_consumption)}%</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Verbrauch aus der Gemeinschaft gedeckt</p>
		</div>
	</section>

	<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 class="font-semibold">Verlauf {energie.bucket === 'day' ? 'je Tag' : 'je Monat'}</h3>
			<div class="flex gap-4 text-xs text-stone-600 dark:text-stone-400">
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-stone-400 dark:bg-stone-500"></span>
					Verbrauch
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500"></span>
					Eigendeckung
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-200 dark:bg-brand-300/60"></span>
					Überschuss
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-red-400"></span>
					unvollständig
				</span>
			</div>
		</div>
		<svg viewBox="0 0 {chartW} {chartH + 26}" class="mt-4 w-full" role="img" aria-label="Verlauf von Verbrauch und Erzeugung">
			{#each [0.5, 1] as frac (frac)}
				<line x1="0" x2={chartW} y1={chartH - frac * chartH} y2={chartH - frac * chartH} class="stroke-stone-200 dark:stroke-stone-800" stroke-dasharray="3 4" />
				<text x="2" y={chartH - frac * chartH - 4} class="fill-stone-400 text-[10px] dark:fill-stone-500">{kwh(maxKwh * frac)}</text>
			{/each}
			{#each series as d, i (d.key)}
				{@const cx = i * slotW + slotW / 2}
				<g>
					<title>{d.label}: Verbrauch {kwh(d.total_consumption)}, Erzeugung {kwh(d.total_production)}, Eigendeckung {kwh(d.self_use)}{d.incomplete_days ? `, ${d.incomplete_days} unvollständige Tage` : ''}</title>
					<rect x={cx - barW - 1} y={chartH - y(d.total_consumption)} width={barW} height={y(d.total_consumption)} rx="1.5" class="fill-stone-400 dark:fill-stone-500" />
					<rect x={cx + 1} y={chartH - y(d.self_use)} width={barW} height={y(d.self_use)} rx="1.5" class="fill-brand-500" />
					<rect x={cx + 1} y={chartH - y(d.self_use) - y(d.overshoot)} width={barW} height={y(d.overshoot)} rx="1.5" class="fill-brand-200 dark:fill-brand-300/60" />
					{#if d.incomplete_days > 0}
						<rect x={cx - barW - 1} y={chartH + 2} width={2 * barW + 2} height="3" class="fill-red-400" />
					{/if}
					{#if i % labelEvery === 0}
						<text x={cx} y={chartH + 18} text-anchor="middle" class="fill-stone-500 text-[10px] dark:fill-stone-400">{d.label}</text>
					{/if}
				</g>
			{/each}
			<line x1="0" x2={chartW} y1={chartH} y2={chartH} class="stroke-stone-300 dark:stroke-stone-700" />
		</svg>
		<p class="mt-2 text-xs text-stone-500 dark:text-stone-400">
			{totals.days} Tage mit Daten im Zeitraum{#if totals.incomplete_days > 0}, davon {totals.incomplete_days} unvollständig (weniger als die Hälfte der Verbrauchszählpunkte hat gemeldet; solche Teillieferungen aus EEGFaktura werden beim nächsten Import ergänzt){/if}.
		</p>
	</section>
{/if}

<section class="text-xs text-stone-500 dark:text-stone-400">
	Datenbestand: {energie.coverage.points} Zählpunkte ({energie.coverage.consumption_points} Verbrauch),
	Messwerte von {fmtDate(energie.coverage.first_at)} bis {fmtDate(energie.coverage.last_at)}
	{#if sync?.finished_at}· letzter Import {fmtDateTime(sync.finished_at)}{/if}
	· Quelle EEGFaktura, 15-Minuten-Werte, Zeitzone Europe/Vienna.
</section>
