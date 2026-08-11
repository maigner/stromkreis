<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import { profileLabels } from './site-format.js';

	/** @type {{ members: {id: number, name: string}[], center: [number, number] }} */
	let { members, center } = $props();

	const steps = ['Material', 'SD-Karte', 'Registrieren', 'Verbinden', 'Fertig'];
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

	// Schritt 2: simuliertes Flashen der SD-Karte
	/** @type {'idle' | 'running' | 'verify' | 'done'} */
	let flashState = $state('idle');
	let flashPct = $state(0);
	function startFlash() {
		flashState = 'running';
		flashPct = 0;
		const iv = setInterval(() => {
			flashPct = Math.min(100, flashPct + 2 + Math.random() * 5);
			if (flashPct >= 100) {
				clearInterval(iv);
				flashState = 'verify';
				setTimeout(() => (flashState = 'done'), 1400);
			}
		}, 120);
	}

	// Schritt 3: Formular
	let name = $state('');
	let memberId = $state('');
	let address = $state('');
	// Startwerte bewusst einmalig vom Gemeinschafts-Mittelpunkt uebernommen
	// svelte-ignore state_referenced_locally
	let latitude = $state(center[1].toFixed(4));
	// svelte-ignore state_referenced_locally
	let longitude = $state(center[0].toFixed(4));
	let profile = $state('fronius-symo');
	let capacityKwh = $state('10');
	let pvKwp = $state('8');
	let saving = $state(false);
	let formError = $state('');
	let created = $state(/** @type {{id: number, token: string} | null} */ (null));

	/** @returns {(input: any) => Promise<void>} */
	function submitAnlegen() {
		saving = true;
		formError = '';
		return async ({ result }) => {
			saving = false;
			if (result.type === 'success' && result.data?.id) {
				created = /** @type {any} */ (result.data);
			} else if (result.type === 'failure') {
				formError = result.data?.message ?? 'Bitte die Eingaben prüfen.';
			} else {
				formError = 'Speichern fehlgeschlagen, bitte erneut versuchen.';
			}
		};
	}

	// Schritt 4: simulierte Erstverbindung, der Status-Push passiert am Server
	/** @type {'idle' | 'running' | 'done' | 'error'} */
	let connectState = $state('idle');
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
		await pushLine('$ ssh openhabian@openhabian.local', 'text-neutral-400');
		await sleep(600);
		await pushLine(`openhabian@openhabian:~$ sudo stromkreis-setup --profil ${profile}`, 'text-neutral-400');
		await sleep(500);
		await pushLine(`Installiere Gateway-Paket '${profile}' ...`);
		await sleep(900);
		await pushLine('Wechselrichter gefunden: 192.168.1.40 (Modbus TCP)');
		await sleep(700);
		await pushLine('Fail-Safe geprueft: Standardverhalten bei Plattform-Ausfall OK', 'text-green-400');
		await sleep(700);
		await pushLine('Auto-Revert geprueft: Vorgabe laeuft nach 60 s automatisch ab OK', 'text-green-400');
		await sleep(600);
		await pushLine('Sende ersten Status-Push an https://stromkreis.net ...');
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

	// Kopierhilfe
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

	const gatewayConf = $derived(
		created
			? `PLATTFORM_URL=https://stromkreis.net\nANLAGEN_TOKEN=${created.token}\nPROFIL=${profile}`
			: ''
	);

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
		<span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
			Demo-Mandant: simulierter Einrichtungsablauf
		</span>
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
			<h3 class="font-semibold">SD-Karte mit openHABian beschreiben</h3>
			<ol class="mt-3 list-decimal space-y-2 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
				<li>
					Raspberry Pi Imager von
					<a href="https://www.raspberrypi.com/software/" target="_blank" rel="noreferrer" class="font-medium text-amber-600 hover:underline dark:text-amber-500">raspberrypi.com/software</a>
					installieren und starten.
				</li>
				<li>Unter "Betriebssystem" wählen: Other specific-purpose OS, Home automation, openHABian (64-bit).</li>
				<li>Die microSD-Karte als Ziel wählen und schreiben. Alle Daten auf der Karte werden gelöscht.</li>
			</ol>

			<div class="mt-5 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
				{#if flashState === 'idle'}
					<button class={secondaryBtn} onclick={startFlash}>Schreibvorgang ansehen (Demo)</button>
				{:else}
					<p class="font-mono text-xs text-neutral-600 dark:text-neutral-400">
						{#if flashState === 'running'}
							Schreibe openhabian-1.9.1-arm64.img auf die SD-Karte ... {Math.floor(flashPct)}%
						{:else if flashState === 'verify'}
							Überprüfe die geschriebenen Daten ...
						{:else}
							Überprüfung abgeschlossen, die SD-Karte kann entnommen werden.
						{/if}
					</p>
					<div class="mt-2 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800">
						<div
							class="h-2 rounded-full {flashState === 'done' ? 'bg-green-500' : 'bg-amber-500'}"
							style="width: {Math.min(100, flashPct)}%"
						></div>
					</div>
				{/if}
			</div>

			{#if flashState === 'done'}
				<p class="mt-4 text-sm text-neutral-700 dark:text-neutral-300">
					Jetzt die SD-Karte in den Raspberry Pi stecken, Netzwerkkabel und Strom anschließen. openHABian installiert sich unbeaufsichtigt, das dauert je nach Internetanschluss 15 bis 45 Minuten. In der Zwischenzeit geht es hier weiter.
				</p>
			{/if}
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 1)}>Zurück</button>
			<button class={primaryBtn} disabled={flashState !== 'done'} onclick={() => (step = 3)}>Weiter</button>
		</div>
	{:else if step === 3}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">Anlage auf der Plattform registrieren</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Die Anlage bekommt einen eigenen Zugangstoken. Das Gateway meldet sich damit ausschließlich ausgehend per HTTPS, ein Zugriff von außen ins Heimnetz ist nie nötig.
			</p>

			{#if !created}
				<form method="POST" action="?/anlegen" use:enhance={submitAnlegen} class="mt-4 grid gap-4 sm:grid-cols-2">
					<label class="block text-sm sm:col-span-2">
						<span class="text-neutral-600 dark:text-neutral-400">Name der Anlage</span>
						<input name="name" bind:value={name} required placeholder="z.B. Anlage Laakirchen" class={inputCls} />
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Mitglied</span>
						<select name="member_id" bind:value={memberId} class={inputCls}>
							<option value="">Ohne Mitglied</option>
							{#each members as m (m.id)}
								<option value={m.id}>{m.name}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm">
						<span class="text-neutral-600 dark:text-neutral-400">Wechselrichterprofil</span>
						<select name="profile" bind:value={profile} class={inputCls}>
							{#each Object.entries(profileLabels) as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm sm:col-span-2">
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
					<p class="text-sm font-medium text-amber-800 dark:text-amber-300">
						Gateway-Token, wird nur einmal angezeigt:
					</p>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<code class="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-neutral-950">{created.token}</code>
						<button class="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400" onclick={() => created && copy(created.token, 'token')}>
							{copied === 'token' ? 'Kopiert' : 'Kopieren'}
						</button>
					</div>
					<p class="mt-2 text-xs text-amber-800 dark:text-amber-300">
						Auf der Plattform ist nur ein Hash gespeichert. Geht der Token verloren, muss ein neuer erzeugt werden.
					</p>
				</div>
			{/if}
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 2)}>Zurück</button>
			<button class={primaryBtn} disabled={!created} onclick={() => (step = 4)}>Weiter</button>
		</div>
	{:else if step === 4}
		<div class="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
			<h3 class="font-semibold">Gateway verbinden</h3>
			<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
				Sobald der Raspberry Pi fertig installiert ist, per SSH anmelden (Benutzer und Passwort openhabian, danach gleich ändern) und die Zugangsdaten hinterlegen:
			</p>

			<div class="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
				<div class="flex items-start justify-between gap-2">
					<pre class="overflow-x-auto font-mono text-xs leading-relaxed text-neutral-800 dark:text-neutral-300">sudo mkdir -p /etc/stromkreis
sudo nano /etc/stromkreis/gateway.conf</pre>
				</div>
				<div class="mt-3 flex items-start justify-between gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
					<pre class="overflow-x-auto font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-neutral-800 dark:text-neutral-300">{gatewayConf}</pre>
					<button class="shrink-0 text-xs font-medium text-amber-700 hover:underline dark:text-amber-400" onclick={() => copy(gatewayConf, 'conf')}>
						{copied === 'conf' ? 'Kopiert' : 'Kopieren'}
					</button>
				</div>
			</div>

			<p class="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
				Danach richtet <code class="font-mono text-xs">sudo stromkreis-setup --profil {profile}</code> die Steuerlogik ein, prüft Fail-Safe und Auto-Revert und schickt den ersten Status-Push.
			</p>

			{#if connectState === 'idle'}
				<form method="POST" action="?/aktivieren" use:enhance={submitAktivieren} class="mt-4">
					<input type="hidden" name="site_id" value={created?.id} />
					<button class={primaryBtn}>Erstverbindung ansehen (Demo)</button>
				</form>
			{:else}
				<div
					bind:this={termEl}
					class="mt-4 max-h-72 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-[13px] leading-relaxed text-neutral-200"
				>
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
		</div>
		<div class="flex justify-between">
			<button class={secondaryBtn} onclick={() => (step = 3)}>Zurück</button>
			<button class={primaryBtn} disabled={connectState !== 'done'} onclick={() => (step = 5)}>Weiter</button>
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
