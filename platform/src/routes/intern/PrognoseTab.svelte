<script>
	import { de } from './site-format.js';

	/**
	 * Tab "Prognose": Verbrauchs- und Erzeugungsprognose der naechsten 14 Tage
	 * aus dem juengsten Prognoselauf der Pipeline plus Wetterentwicklung im
	 * selben Fenster (siehe lib/server/prognose.js).
	 * @type {{ prognose: import('$lib/server/prognose.js').loadPrognose extends (...a: any) => Promise<infer R> ? R : never, sync: any }}
	 */
	let { prognose, sync } = $props();

	const run = $derived(prognose.run);
	const hours = $derived(prognose.hours);
	const days = $derived(prognose.days);
	const weather = $derived(prognose.weather);

	const kwh = (/** @type {number} */ x) => `${de(x, x >= 100 ? 0 : 1)} kWh`;
	const fmtDate = (/** @type {string} */ iso) =>
		new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' });
	const fmtDateTime = (/** @type {string} */ iso) =>
		new Date(iso).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

	// Durchschnitte ueber die vollen Prognosetage im Fenster
	const avg = (/** @type {(d: any) => number} */ f) =>
		days.length ? days.reduce((/** @type {number} */ a, /** @type {any} */ d) => a + f(d), 0) / days.length : 0;
	const stats = $derived({
		consumption: avg((d) => d.consumption),
		generation: avg((d) => d.generation),
		self_coverage: avg((d) => d.self_coverage),
		coverage_pct: avg((d) => d.consumption) > 0 ? (100 * avg((d) => d.self_coverage)) / avg((d) => d.consumption) : 0
	});

	// Diagramme: Stundenwerte als Linien ueber 14 Tage (bis zu 336 Punkte auf
	// 720 Einheiten Breite); Tagesgrenzen (lokale Mitternacht) als Gitter
	const chartH = 210;
	const chartW = 720;

	/** @param {{ ts: string }[]} series */
	const ticksOf = (series) =>
		series.reduce((/** @type {{ i: number, label: string }[]} */ acc, h, i) => {
			const local = new Date(h.ts).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', hour: '2-digit', hour12: false });
			if (local.startsWith('00')) {
				const d = new Date(h.ts);
				acc.push({ i, label: `${d.toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', weekday: 'short' })} ${d.toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', day: 'numeric', month: 'numeric' })}` });
			}
			return acc;
		}, []);
	/** @param {number} n */
	const xOf = (n) => (/** @type {number} */ i) => (n > 1 ? (i / (n - 1)) * chartW : 0);

	// --- Prognose-Diagramm -------------------------------------------------
	const maxKwh = $derived(
		Math.max(1, ...hours.map((h) => Math.max(h.consumption_p90 ?? h.consumption, h.generation_p90 ?? h.generation)))
	);
	const x = $derived(xOf(hours.length));
	const y = (/** @type {number} */ v) => chartH - (Math.max(0, v) / maxKwh) * chartH;
	const linePath = (/** @type {(h: any) => number} */ f) =>
		hours.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(f(h)).toFixed(1)}`).join('');
	const bandPath = (/** @type {(h: any) => number | null} */ lo, /** @type {(h: any) => number | null} */ hi) => {
		if (!hours.length || hours.some((h) => lo(h) == null || hi(h) == null)) return '';
		const up = hours.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(/** @type {number} */ (hi(h))).toFixed(1)}`).join('');
		const down = [...hours].reverse().map((h, i) => `L${x(hours.length - 1 - i).toFixed(1)},${y(/** @type {number} */ (lo(h))).toFixed(1)}`).join('');
		return `${up}${down}Z`;
	};
	const dayTicks = $derived(ticksOf(hours));

	// --- Wetter-Diagramm ---------------------------------------------------
	// Globalstrahlung als Flaeche (eigener Massstab rechts), Temperatur als
	// Linie (Massstab links, mit Luft nach oben und unten), Regen als Balken
	const wx = $derived(xOf(weather.length));
	const wTicks = $derived(ticksOf(weather));
	const tMin = $derived(Math.floor(Math.min(0, ...weather.map((w) => w.temperature)) / 5) * 5);
	const tMax = $derived(Math.ceil(Math.max(5, ...weather.map((w) => w.temperature)) / 5) * 5 + 5);
	const yTemp = (/** @type {number} */ v) => chartH - ((v - tMin) / (tMax - tMin)) * chartH;
	const maxRad = $derived(Math.max(100, ...weather.map((w) => w.radiation)));
	const yRad = (/** @type {number} */ v) => chartH - (Math.max(0, v) / maxRad) * chartH;
	const maxRain = $derived(Math.max(1, ...weather.map((w) => w.rain)));
	const tempPath = $derived(
		weather.map((w, i) => `${i === 0 ? 'M' : 'L'}${wx(i).toFixed(1)},${yTemp(w.temperature).toFixed(1)}`).join('')
	);
	const radPath = $derived(
		weather.length
			? weather.map((w, i) => `${i === 0 ? 'M' : 'L'}${wx(i).toFixed(1)},${yRad(w.radiation).toFixed(1)}`).join('') +
				`L${chartW},${chartH}L0,${chartH}Z`
			: ''
	);

	const cardCls = 'rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900';
</script>

<section class="flex flex-wrap items-baseline justify-between gap-3">
	<h2 class="text-lg font-semibold">Verbrauchs- und Erzeugungsprognose</h2>
	<p class="text-xs text-stone-500 dark:text-stone-400">nächste 14 Tage, je Stunde</p>
</section>

{#if !run}
	<section class={cardCls}>
		<p class="text-sm text-stone-600 dark:text-stone-400">
			{#if sync && sync.phase !== 'done' && sync.phase !== 'error'}
				Der Import aus EEGFaktura läuft noch; die Prognose wird direkt danach gerechnet und erscheint hier.
			{:else}
				Noch keine Prognose vorhanden. Sie wird nach dem nächsten EEGFaktura-Import gerechnet; dafür braucht es mindestens zwei Wochen vollständige Messdaten.
			{/if}
		</p>
	</section>
{:else if hours.length === 0}
	<section class={cardCls}>
		<p class="text-sm text-stone-600 dark:text-stone-400">
			Der letzte Prognoselauf vom {fmtDateTime(run.created_at)} reicht nicht bis heute. Der nächste Lauf kommt automatisch (spätestens täglich).
		</p>
	</section>
{:else}
	<section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Ø Verbrauch pro Tag</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.consumption)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">erwarteter Gesamtverbrauch der Mitglieder</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Ø Erzeugung pro Tag</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.generation)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">erwartete gemeinschaftliche Erzeugung, aus der Wetterprognose</p>
		</div>
		<div class="{cardCls} border-brand-300 dark:border-brand-700">
			<p class="text-sm text-brand-700 dark:text-brand-300">Ø davon selbst gedeckt</p>
			<p class="mt-1 text-3xl font-semibold">{kwh(stats.self_coverage)}</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Verbrauch, den die Gemeinschaft direkt deckt</p>
		</div>
		<div class={cardCls}>
			<p class="text-sm text-stone-500 dark:text-stone-400">Ø Deckungsgrad</p>
			<p class="mt-1 text-3xl font-semibold">{de(stats.coverage_pct, 0)}%</p>
			<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Anteil des Verbrauchs aus der Gemeinschaft</p>
		</div>
	</section>

	<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 class="font-semibold">Prognose je Stunde</h3>
			<div class="flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
				<span class="flex items-center gap-1.5">
					<span class="inline-block w-4 border-t-2 border-sky-600"></span>
					Verbrauch
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block w-4 border-t-2 border-amber-500"></span>
					Erzeugung
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500/60"></span>
					davon aus der Gemeinschaft
				</span>
				<span class="flex items-center gap-1.5">
					<span class="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/30"></span>
					Unsicherheitsband (p10 bis p90)
				</span>
			</div>
		</div>
		<svg viewBox="0 0 {chartW} {chartH + 26}" class="mt-4 w-full" role="img" aria-label="Verbrauchs- und Erzeugungsprognose je Stunde für die nächsten 14 Tage">
			{#each [0.5, 1] as frac (frac)}
				<line x1="0" x2={chartW} y1={chartH - frac * chartH} y2={chartH - frac * chartH} class="stroke-stone-200 dark:stroke-stone-800" stroke-dasharray="3 4" />
				<text x="2" y={chartH - frac * chartH - 4} class="fill-stone-400 text-[10px] dark:fill-stone-500">{kwh(maxKwh * frac)}</text>
			{/each}
			{#each dayTicks as t (t.i)}
				<line x1={x(t.i)} x2={x(t.i)} y1="0" y2={chartH} class="stroke-stone-200 dark:stroke-stone-800" />
			{/each}
			<path d={bandPath((h) => h.generation_p10, (h) => h.generation_p90)} class="fill-amber-400/25 dark:fill-amber-500/20" />
			<path d={bandPath((h) => h.consumption_p10, (h) => h.consumption_p90)} class="fill-sky-500/15 dark:fill-sky-400/15" />
			<path d="{linePath((h) => h.self_coverage)}L{chartW},{chartH}L0,{chartH}Z" class="fill-brand-500/25" />
			<path d={linePath((h) => h.generation)} fill="none" class="stroke-amber-500" stroke-width="1.4" />
			<path d={linePath((h) => h.consumption)} fill="none" class="stroke-sky-600" stroke-width="1.4" />
			{#each dayTicks as t, j (t.i)}
				{#if j % 2 === 0}
					<text x={x(t.i) + 3} y={chartH + 16} class="fill-stone-500 text-[10px] dark:fill-stone-400">{t.label}</text>
				{/if}
			{/each}
			<line x1="0" x2={chartW} y1={chartH} y2={chartH} class="stroke-stone-300 dark:stroke-stone-700" />
		</svg>
		<p class="mt-3 text-xs text-stone-500 dark:text-stone-400">
			Prognoselauf vom {fmtDateTime(run.created_at)} (Modell {run.model_version}), Messdaten bis {fmtDate(`${run.data_until}T12:00:00+02:00`)}.
			Das Modell lernt aus Kalender, Sonnenstand und Wetter (Open-Meteo für den Standort der EEG) je Zählpunkt und rechnet auf die Gemeinschaft hoch; nach jedem EEGFaktura-Import und spätestens täglich wird neu gerechnet.
		</p>
	</section>

	{#if weather.length > 0}
		<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h3 class="font-semibold">Wetterentwicklung</h3>
				<div class="flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-400">
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/50"></span>
						Globalstrahlung
					</span>
					<span class="flex items-center gap-1.5">
						<span class="inline-block w-4 border-t-2 border-red-500"></span>
						Temperatur
					</span>
					<span class="flex items-center gap-1.5">
						<span class="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500/70"></span>
						Regen
					</span>
				</div>
			</div>
			<svg viewBox="0 0 {chartW} {chartH + 26}" class="mt-4 w-full" role="img" aria-label="Wetterentwicklung für die nächsten 14 Tage: Globalstrahlung, Temperatur und Regen je Stunde">
				{#each [0.25, 0.5, 0.75, 1] as frac (frac)}
					<line x1="0" x2={chartW} y1={chartH - frac * chartH} y2={chartH - frac * chartH} class="stroke-stone-200 dark:stroke-stone-800" stroke-dasharray="3 4" />
					<text x="2" y={chartH - frac * chartH - 4} class="fill-stone-400 text-[10px] dark:fill-stone-500">{de(tMin + frac * (tMax - tMin), 0)}°C</text>
					<text x={chartW - 2} y={chartH - frac * chartH - 4} text-anchor="end" class="fill-amber-500/80 text-[10px]">{de(maxRad * frac, 0)} W/m²</text>
				{/each}
				{#each wTicks as t (t.i)}
					<line x1={wx(t.i)} x2={wx(t.i)} y1="0" y2={chartH} class="stroke-stone-200 dark:stroke-stone-800" />
				{/each}
				<path d={radPath} class="fill-amber-400/30 dark:fill-amber-500/25" />
				{#each weather as w, i (w.ts)}
					{#if w.rain > 0}
						<rect x={wx(i) - 0.9} y={chartH - (w.rain / maxRain) * chartH * 0.5} width="1.8" height={(w.rain / maxRain) * chartH * 0.5} class="fill-sky-500/70">
							<title>{de(w.rain, 1)} mm Regen</title>
						</rect>
					{/if}
				{/each}
				<path d={tempPath} fill="none" class="stroke-red-500" stroke-width="1.4" />
				{#if tMin < 0}
					<line x1="0" x2={chartW} y1={yTemp(0)} y2={yTemp(0)} class="stroke-stone-400 dark:stroke-stone-600" stroke-dasharray="6 4" />
				{/if}
				{#each wTicks as t, j (t.i)}
					{#if j % 2 === 0}
						<text x={wx(t.i) + 3} y={chartH + 16} class="fill-stone-500 text-[10px] dark:fill-stone-400">{t.label}</text>
					{/if}
				{/each}
				<line x1="0" x2={chartW} y1={chartH} y2={chartH} class="stroke-stone-300 dark:stroke-stone-700" />
			</svg>
			<p class="mt-3 text-xs text-stone-500 dark:text-stone-400">
				Open-Meteo-Stundenwerte für den Standort der EEG, gleiches Zeitfenster wie die Prognose. Die Globalstrahlung (Fläche, Skala rechts) treibt die Erzeugungsprognose; Temperatur links, Regenstunden als Balken.
			</p>
		</section>
	{/if}
{/if}
