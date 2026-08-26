<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import { profileLabels } from './site-format.js';

	/**
	 * Einrichtungs-Assistent nach dem ISCHLSTROM-Modell: Anlage registrieren,
	 * SD-Karten-Dateien (nur Einrichtungscode und Plattform-URL) herunterladen,
	 * das Gateway holt sich beim ersten Start seine Konfiguration selbst.
	 * @type {{ members: {id: number, name: string, participant_number?: string | null, address?: string | null, points: {id: number, metering_point: string, direction: string}[]}[], center: [number, number], demo: boolean, sites: {id: number, name: string, setup_phase: string, setup_message: string | null, setup_percent: number, setup_label: string, provision_code: string | null, provision_expires_at: string | null, online: boolean}[] }}
	 */
	let { members, center, demo, sites } = $props();

	const steps = ['Material', 'Registrieren', 'SD-Karte', 'Verbinden', 'Fertig'];
	let step = $state(1);

	// Schritt 1: Checkliste
	const checklist = [
		'Raspberry Pi 4 oder 5 (ab 2 GB RAM) mit Netzteil',
		'microSD-Karte ab 32 GB und ein Kartenleser',
		'Netzwerkkabel zum Router (WLAN geht, LAN ist stabiler)',
		'Wechselrichter im Heimnetz erreichbar, Modbus TCP aktiviert',
		'Risikoaufklärung mit dem Mitglied besprochen und unterschrieben'
	];
	let checked = $state(checklist.map(() => false));
	const allChecked = $derived(checked.every(Boolean));

	// Schritt 2: Formular
	let name = $state('');
	let memberId = $state('');
	let pointId = $state('');
	let address = $state('');
	// Startwerte bewusst einmalig vom Gemeinschafts-Mittelpunkt uebernommen
	// svelte-ignore state_referenced_locally
	let latitude = $state(center[1].toFixed(4));
	// svelte-ignore state_referenced_locally
	let longitude = $state(center[0].toFixed(4));
	let profile = $state('fronius-symo');
	let capacityKwh = $state('10');
	let pvKwp = $state('8');
	let wifiSsid = $state('');
	let wifiPassword = $state('');
	let saving = $state(false);
	let formError = $state('');
	let created = $state(/** @type {{id: number, code: string, expires: string} | null} */ (null));

	const selectedMember = $derived(members.find((m) => String(m.id) === String(memberId)));
	$effect(() => {
		// Adresse und Name aus dem Mitglied vorbelegen, solange nichts eingetippt wurde
		if (selectedMember) {
			if (!address && selectedMember.address) address = selectedMember.address;
			if (!name) name = `Anlage ${selectedMember.name}`;
		}
	});

	/** @returns {(input: any) => Promise<void>} */
	function submitAnlegen() {
		saving = true;
		formError = '';
		return async ({ result }) => {
			saving = false;
			if (result.type === 'success' && result.data?.id) {
				created = /** @type {any} */ (result.data);
				await invalidateAll();
			} else if (result.type === 'failure') {
				formError = result.data?.message ?? 'Bitte die Eingaben prüfen.';
			} else {
				formError = 'Speichern fehlgeschlagen, bitte erneut versuchen.';
			}
		};
	}

	// Demo-Mandant: Zustand der simulierten Erstverbindung
	/** @type {'idle' | 'running' | 'done' | 'error'} */
	let connectState = $state('idle');

	// Schritt 4: Fortschritt der Einrichtung (das Gateway meldet Phasen an die Plattform)
	const currentSite = $derived(created ? sites.find((s) => s.id === created?.id) : undefined);
	const setupDone = $derived(currentSite?.setup_phase === 'fertig' || (demo && /** @type {string} */ (connectState) === 'done'));
	$effect(() => {
		if (step !== 4 || demo) return;
		const t = setInterval(() => invalidateAll(), 15000);
		return () => clearInterval(t);
	});

	// Demo-Mandant: simulierte Erstverbindung (Status-Push passiert am Server)
	/** @type {{text: string, cls?: string}[]} */
	let consoleLines = $state([]);
	/** @type {HTMLDivElement | undefined} */
	let termEl = $state();
	const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
	async function pushLine(/** @type {string} */ text, /** @type {string | undefined} */ cls = undefined) {
		consoleLines.push({ text, cls });
		await tick();
		if (termEl) termEl.scrollTop = termEl.scrollHeight;
	}
	async function playConsole() {
		await pushLine('[stromkreis-firstboot] Einrichtungscode gefunden, hole Konfiguration ...', 'text-neutral-400');
		await sleep(700);
		await pushLine(`POST /api/gateway/provision/v1 -> 200, Anlage "${name}"`);
		await sleep(600);
		await pushLine(`Installiere Gateway-Paket '${profile}' ...`);
		await sleep(900);
		await pushLine('Wechselrichter gefunden: 192.168.1.40 (Modbus TCP)');
		await sleep(700);
		await pushLine('Fail-Safe geprueft: Standardverhalten bei Plattform-Ausfall OK', 'text-green-400');
		await sleep(700);
		await pushLine('Auto-Revert geprueft: Vorgabe laeuft nach 60 s automatisch ab OK', 'text-green-400');
		await sleep(600);
		await pushLine('Sende ersten Status-Push ...');
		await sleep(800);
	}
	/** @returns {(input: any) => Promise<void>} */
	function submitAktivieren() {
		connectState = 'running';
		consoleLines = [];
		const anim = playConsole();
		return async ({ result }) => {
			await anim;
			if (result.type === 'success') {
				await pushLine('HTTP 200, die Anlage ist online.', 'text-green-400');
				connectState = 'done';
				await invalidateAll();
			} else {
				await pushLine('Fehler beim Status-Push, bitte erneut versuchen.', 'text-red-400');
				connectState = 'error';
			}
		};
	}

	let copied = $state('');
	async function copy(/** @type {string} */ text, /** @type {string} */ key) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => {
				if (copied === key) copied = '';
			}, 1500);
		} catch {
			// Zwischenablage nicht verfuegbar, kein Fehler noetig
		}
	}
	const fmtDate = (/** @type {string} */ iso) => new Date(iso).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' });

	const inputCls =
		'mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';
	const primaryBtn =
		'rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50';
	const secondaryBtn =
		'rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
</script>

<section class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h2 class="text-lg font-semibold">Neue Anlage einrichten</h2>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Von der leeren SD-Karte bis zum laufenden Batteriemanagement, Schritt für Schritt
			</p>
		</div>
		{#if demo}
			<span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
				Demo-Mandant: Erstverbindung wird simuliert
			</span>
		{/if}
	</div>

	<ol class="flex flex-wrap gap-2 text-xs" aria-label="Einrichtungsschritte">
		{#each steps as s, i (s)}
			<li
				class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 {i + 1 === step
					? 'border-amber-500 font-medium text-neutral-900 dark:text-neutral-100'
					: i + 1 < step
						? 'border-green-600/40 text-green-700 dark:text-green-500'
						: 'border-neutral-200 text-neutral-500 dark:border-neutral-800 dark:text-neutral-400'}"
			>
				<span>{i + 1 < step ? '✓' : `${i + 1}.`}</span>
				{s}
			</li>
		{/each}
	</ol>

	{#if step === 1}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">Material bereitlegen</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Alles da? Dann dauert die Einrichtung etwa eine Stunde, das meiste davon wartet der Raspberry Pi von selbst ab.
			</p>
			<ul class="mt-4 space-y-2">
				{#each checklist as item, i (item)}
					<li>
						<label class="flex cursor-pointer items-start gap-3 text-sm">
							<input type="checkbox" bind:checked={checked[i]} class="mt-0.5 h-4 w-4 accent-amber-500" />
							<span>{item}</span>
						</label>
					</li>
				{/each}
			</ul>
			<p class="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
				Die unterschriebene Risikoaufklärung ist Startvoraussetzung: Fail-Safe und Auto-Revert sind Pflicht, das Restrisiko wird je Anlage dokumentiert.
			</p>
		</div>
		<div class="flex justify-end">
			<button class={primaryBtn} disabled={!allChecked} onclick={() => (step = 2)}>Weiter</button>
		</div>
	{:else if step === 2}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">Anlage auf der Plattform registrieren</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Die Anlage bekommt einen Einrichtungscode. Das Gateway meldet sich damit ausschließlich ausgehend per HTTPS und holt sich seinen Zugangstoken selbst; ein Zugriff von außen ins Heimnetz ist nie nötig.
			</p>

			{#if !created}
				<form method="POST" action="?/anlegen" use:enhance={submitAnlegen} class="mt-4 grid gap-4 sm:grid-cols-2">
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Mitglied</span>
						<select name="member_id" bind:value={memberId} class={inputCls}>
							<option value="">Ohne Mitglied</option>
							{#each members as m (m.id)}
								<option value={m.id}>{m.participant_number ? `${m.participant_number} · ` : ''}{m.name}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Zählpunkt der Anlage</span>
						<select name="measurement_point_id" bind:value={pointId} class={inputCls} disabled={!selectedMember}>
							<option value="">{selectedMember ? 'Kein Zählpunkt' : 'Zuerst Mitglied wählen'}</option>
							{#each selectedMember?.points ?? [] as p (p.id)}
								<option value={p.id}>{p.direction === 'generation' ? 'Erzeugung' : 'Verbrauch'} · {p.metering_point}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm sm:col-span-2">
						<span class="text-neutral-600 dark:text-neutral-400">Name der Anlage</span>
						<input name="name" bind:value={name} required placeholder="z.B. Anlage Huber" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Wechselrichterprofil</span>
						<select name="profile" bind:value={profile} class={inputCls}>
							{#each Object.entries(profileLabels) as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Adresse</span>
						<input name="address" bind:value={address} required placeholder="Straße Nr, PLZ Ort" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Breitengrad</span>
						<input name="latitude" bind:value={latitude} required inputmode="decimal" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Längengrad</span>
						<input name="longitude" bind:value={longitude} required inputmode="decimal" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Batteriekapazität (kWh)</span>
						<input name="capacity_kwh" bind:value={capacityKwh} required inputmode="decimal" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">PV-Leistung (kWp)</span>
						<input name="pv_kwp" bind:value={pvKwp} required inputmode="decimal" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">WLAN-Name (optional, sonst LAN)</span>
						<input name="wifi_ssid" bind:value={wifiSsid} class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">WLAN-Passwort</span>
						<input name="wifi_password" type="password" bind:value={wifiPassword} class={inputCls} disabled={!wifiSsid} />
					</label>
					{#if formError}
						<p class="text-sm text-red-600 sm:col-span-2 dark:text-red-500">{formError}</p>
					{/if}
					<div class="sm:col-span-2">
						<button class={primaryBtn} disabled={saving}>
							{saving ? 'Wird registriert ...' : 'Anlage registrieren'}
						</button>
					</div>
				</form>
			{:else}
				<div class="mt-4 rounded-md border border-green-600/30 bg-green-50 p-4 text-sm dark:bg-green-950/40">
					<p class="font-medium text-green-800 dark:text-green-400">Anlage "{name}" ist registriert.</p>
				</div>
				<div class="mt-4 rounded-md border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/40">
					<p class="text-sm font-medium text-amber-800 dark:text-amber-300">Einrichtungscode (gültig bis {fmtDate(created.expires)}):</p>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<code class="rounded bg-white px-2 py-1 font-mono text-lg tracking-widest dark:bg-neutral-950">{created.code}</code>
						<button class="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400" onclick={() => created && copy(created.code, 'code')}>
							{copied === 'code' ? 'Kopiert' : 'Kopieren'}
						</button>
					</div>
					<p class="mt-2 text-xs text-amber-800 dark:text-amber-300">
						Der Code ist kein Passwort: Das Gateway tauscht ihn beim ersten Start gegen seinen Zugangstoken. Im SD-Karten-Image liegt nur der Code.
					</p>
				</div>
			{/if}
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 1)}>Zurück</button>
			<button class={primaryBtn} disabled={!created} onclick={() => (step = 3)}>Weiter</button>
		</div>
	{:else if step === 3}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">SD-Karte schreiben</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Stromkreis arbeitet ausschließlich mit fertigen SD-Karten-Images: openHABian plus Hostname, Zeitzone, WLAN (falls angegeben), Einrichtungscode und Plattform-URL, fix und fertig eingebaut. Kein Token, kein Passwort der Plattform im Image.
			</p>
			<div class="mt-4 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
				Die Image-Erstellung auf der Plattform ist in Arbeit. Bis dahin: Einrichtungscode
				{#if created}<code class="font-mono tracking-widest">{created.code}</code>{/if}
				notieren; das Image wird demnächst hier zum Download erscheinen.
			</div>
			<ol class="mt-4 list-decimal space-y-2 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
				<li>
					Das Image mit dem Raspberry Pi Imager (<a href="https://www.raspberrypi.com/software/" target="_blank" rel="noreferrer" class="font-medium text-amber-600 hover:underline dark:text-amber-500">raspberrypi.com/software</a>, "Eigenes Image") auf die microSD-Karte schreiben.
				</li>
				<li>Karte in den Raspberry Pi stecken, Netzwerk und Strom anschließen. openHABian installiert sich unbeaufsichtigt (15 bis 45 Minuten), holt dann mit dem Code seine Konfiguration von Stromkreis und meldet den Fortschritt hierher.</li>
			</ol>
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 2)}>Zurück</button>
			<button class={primaryBtn} onclick={() => (step = 4)}>Weiter</button>
		</div>
	{:else if step === 4}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">Gateway verbindet sich</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Sobald der Raspberry Pi mit Strom und Netzwerk verbunden ist, erscheint hier der Fortschritt. Die Einrichtung dauert etwa 30 bis 45 Minuten; diese Seite aktualisiert sich von selbst.
			</p>
			{#if currentSite}
				<div class="mt-4">
					<div class="flex items-baseline justify-between text-sm">
						<span class="font-medium">{currentSite.setup_label}</span>
						<span class="text-xs text-neutral-500">{currentSite.setup_percent}%</span>
					</div>
					<div class="mt-2 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800">
						<div class="h-2 rounded-full {currentSite.setup_phase === 'fertig' ? 'bg-green-500' : 'bg-amber-500'}" style="width: {currentSite.setup_percent}%"></div>
					</div>
					{#if currentSite.setup_message}
						<p class="mt-2 font-mono text-xs text-neutral-600 dark:text-neutral-400">{currentSite.setup_message}</p>
					{/if}
				</div>
			{/if}

			{#if demo}
				<p class="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
					Im Demo-Mandanten gibt es keinen echten Raspberry Pi; die Erstverbindung wird simuliert.
				</p>
				{#if connectState === 'idle'}
					<form method="POST" action="?/aktivieren" use:enhance={submitAktivieren} class="mt-4">
						<input type="hidden" name="site_id" value={created?.id} />
						<button class={primaryBtn}>Erstverbindung ansehen (Demo)</button>
					</form>
				{:else}
					<div bind:this={termEl} class="mt-4 max-h-72 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-[13px] leading-relaxed text-neutral-200">
						{#each consoleLines as line, i (i)}
							<p class="whitespace-pre-wrap {line.cls ?? ''}">{line.text || ' '}</p>
						{/each}
					</div>
					{#if connectState === 'error'}
						<form method="POST" action="?/aktivieren" use:enhance={submitAktivieren} class="mt-3">
							<input type="hidden" name="site_id" value={created?.id} />
							<button class={secondaryBtn}>Erneut versuchen</button>
						</form>
					{/if}
				{/if}
			{/if}
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 3)}>Zurück</button>
			<button class={primaryBtn} disabled={!setupDone} onclick={() => (step = 5)}>Weiter</button>
		</div>
	{:else}
		<div class="rounded-lg border border-green-600/30 bg-white p-6 dark:border-green-600/30 dark:bg-neutral-900">
			<div class="flex items-center gap-3">
				<span class="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-xl text-green-700 dark:bg-green-950 dark:text-green-400">✓</span>
				<div>
					<h3 class="text-lg font-semibold">Die Anlage läuft</h3>
					<p class="text-sm text-neutral-600 dark:text-neutral-400">
						Das Batteriemanagement ist aktiv: Das Gateway holt Ladefenster von der Plattform und meldet seinen Status regelmäßig zurück.
					</p>
				</div>
			</div>
			<ul class="mt-4 space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
				<li>Status-Push alle 5 Minuten, ab 10 Minuten Funkstille gilt die Anlage als offline.</li>
				<li>Fail-Safe: Ohne Plattform fällt die Anlage auf ihr Standardverhalten zurück.</li>
				<li>Auto-Revert: Jede Steuerungsvorgabe läuft ohne Verlängerung automatisch ab.</li>
			</ul>
			<div class="mt-5 flex flex-wrap gap-3">
				{#if created}
					<a href="/intern/anlagen/{created.id}" class={primaryBtn}>Zur Anlage</a>
				{/if}
			</div>
		</div>
	{/if}
</section>
