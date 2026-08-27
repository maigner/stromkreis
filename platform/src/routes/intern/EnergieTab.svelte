<script>
	import { de } from './site-format.js';

	/**
	 * Tab "Energie": Speicherpotential aus PV-Ueberschuss der letzten 30 Tage.
	 * Zeigt bewusst nicht die Energiezahlen, die es schon in EEG-Faktura gibt,
	 * sondern wie viel Ueberschuss ein Batteriespeicher nutzen koennte.
	 * @type {{ energie: import('$lib/server/energie.js').loadEnergie extends (...a: any) => Promise<infer R> ? R : never, sync: any }}
	 */
	let { energie, sync } = $props();

	const days = $derived(energie.days);
	const stats = $derived(energie.stats);
	const hasData = $derived(stats.complete_days > 0);

	const kwh = (/** @type {number} */ x) => `${de(x, x >= 100 ? 0 : 1)} kWh`;
	const fmtDate = (/** @type {string | null} */ iso) =>
		iso ? new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'k.A.';
	const fmtDateTime = (/** @type {string | null} */ iso) =>
		iso ? new Date(iso).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'k.A.';

	// Diagramm: Ueberschuss je Tag, davon der nutzbare Teil (bis zum Netzbezug
	// des Tages) gruen, der Rest amber; gestrichelte Linie = Durchschnitt
	const chartH = 190;
	const chartW = 720;
	const maxKwh = $derived(Math.max(1, ...days.map((t) => t.overshoot)));
	const slotW = $derived(chartW / Math.max(days.length, 1));
	const barW = $derived(Math.min(20, slotW * 0.62));
	const y = (/** @type {number} */ v) => (v / maxKwh) * chartH;
	const avgY = $derived(chartH - y(stats.avg_overshoot));

	const cardCls = 'rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900';
</script>

<section class="flex flex-wrap items-baseline justify-between gap-3">
	<h2 class="text-lg font-semibold">Speicherpotential aus PV-Überschuss</h2>
	<p class="text-xs text-stone-500 dark:text-stone-400">letzte 30 Tage, aus dem EEGFaktura-Import</p>
</section>

{#if !hasData}
	<section class={cardCls}>
		<p class="text-sm text-stone-600 dark:text-stone-400">
			{#if energie.coverage.first_at}
				In den letzten 30 Tagen liegen keine vollständigen Messtage vor. Vorhanden sind Daten von {fmtDate(energie.coverage.first_at)} bis {fmtDate(energie.coverage.last_at)}.
			{:else if sync && sync.phase !== 'done' && sync.phase !== 'error'}
				Der Import aus EEGFaktura läuft noch; die Auswertung erscheint hier, sobald die ersten Tage geladen sind.
			{:else}
				Noch keine Messdaten vorhanden. Die Auswertung kommt mit dem Import aus EEGFaktura.
			{/if}
		</p>
	</section>
{:else}
	<section class="grid grid-cols-1 gap-4 sm:grid-cols-3">
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Ø Überschuss pro Tag</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.avg_overshoot)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">PV-Erzeugung, die die Gemeinschaft nicht direkt verbraucht hat und ins Netz ging</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Ø Netzbezug pro Tag</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.avg_netzbezug)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Verbrauch, der nicht aus der Gemeinschaft gedeckt wurde</p>
		</div>
		<div class="{cardCls} border-brand-300 dark:border-brand-700">
			<p class="text-sm text-brand-700 dark:text-brand-300">Davon mit Speicher nutzbar</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.avg_nutzbar)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Ø pro Tag: Überschuss, der Netzbezug desselben Tages ersetzen könnte (ohne Speicherverluste)</p>
		</div>
	</section>

	<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 class="font-semibold">Überschuss je Tag</h3>
			<div class="flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500"></span>
					mit Speicher nutzbar
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400 dark:bg-amber-500/80"></span>
					auch mit Speicher nicht nutzbar
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block w-4 border-t-2 border-dashed border-stone-500 dark:border-stone-400"></span>
					Ø Überschuss
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-red-400"></span>
					unvollständig
				</span>
			</div>
		</div>
		<svg viewBox="0 0 {chartW} {chartH + 26}" class="mt-4 w-full" role="img" aria-label="PV-Überschuss je Tag der letzten 30 Tage">
			{#each [0.5, 1] as frac (frac)}
				<line x1="0" x2={chartW} y1={chartH - frac * chartH} y2={chartH - frac * chartH} class="stroke-stone-200 dark:stroke-stone-800" stroke-dasharray="3 4" />
				<text x="2" y={chartH - frac * chartH - 4} class="fill-stone-400 text-[10px] dark:fill-stone-500">{kwh(maxKwh * frac)}</text>
			{/each}
			{#each days as t, i (t.key)}
				{@const cx = i * slotW + slotW / 2}
				<g opacity={t.complete ? 1 : 0.45}>
					<title>{t.label} Überschuss {kwh(t.overshoot)}, Netzbezug {kwh(t.netzbezug)}, nutzbar {kwh(t.nutzbar)}{t.has_data ? (t.complete ? '' : ' (unvollständiger Tag)') : ' (keine Daten)'}</title>
					<rect x={cx - barW / 2} y={chartH - y(t.nutzbar)} width={barW} height={y(t.nutzbar)} rx="1.5" class="fill-brand-500" />
					<rect x={cx - barW / 2} y={chartH - y(t.overshoot)} width={barW} height={y(t.overshoot) - y(t.nutzbar)} rx="1.5" class="fill-amber-400 dark:fill-amber-500/80" />
					{#if t.has_data && !t.complete}
						<rect x={cx - barW / 2} y={chartH + 2} width={barW} height="3" class="fill-red-400" />
					{/if}
					{#if i % 3 === 0}
						<text x={cx} y={chartH + 18} text-anchor="middle" class="fill-stone-500 text-[10px] dark:fill-stone-400">{t.label}</text>
					{/if}
				</g>
			{/each}
			<line x1="0" x2={chartW} y1={avgY} y2={avgY} class="stroke-stone-500 dark:stroke-stone-400" stroke-dasharray="6 4" />
			<text x={chartW - 4} y={avgY - 5} text-anchor="end" class="fill-stone-600 text-[10px] font-medium dark:fill-stone-300">Ø {kwh(stats.avg_overshoot)}/Tag</text>
			<line x1="0" x2={chartW} y1={chartH} y2={chartH} class="stroke-stone-300 dark:stroke-stone-700" />
		</svg>
		<p class="mt-3 text-xs text-stone-500 dark:text-stone-400">
			Der Überschuss ist Energie, die derzeit ins öffentliche Netz abfließt. Ein Gemeinschaftsspeicher könnte davon im Schnitt {kwh(stats.avg_nutzbar)} pro Tag zwischenspeichern und damit Netzbezug ersetzen; begrenzt wird das je Tag durch den Netzbezug der Gemeinschaft, Speicherverluste sind nicht eingerechnet.
			Grundlage sind {stats.complete_days} vollständige Tage{#if stats.incomplete_days > 0}; {stats.incomplete_days} unvollständige Tage (Teillieferungen aus EEGFaktura, werden beim nächsten Import ergänzt) zählen nicht in die Durchschnitte{/if}.
		</p>
	</section>
{/if}

<section class="text-xs text-stone-500 dark:text-stone-400">
	Datenbestand: {energie.coverage.points} Zählpunkte ({energie.coverage.consumption_points} Verbrauch),
	Messwerte von {fmtDate(energie.coverage.first_at)} bis {fmtDate(energie.coverage.last_at)}
	{#if sync?.finished_at}· letzter Import {fmtDateTime(sync.finished_at)}{/if}
	· Quelle EEGFaktura, 15-Minuten-Werte, Zeitzone Europe/Vienna.
</section>
