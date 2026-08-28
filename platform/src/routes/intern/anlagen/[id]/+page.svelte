<script>
	import SdImage from '../../SdImage.svelte';
	import SshTerminal from './SshTerminal.svelte';
	import { profileLabels, de, seenLabel, connectionState, watt, batteryLabel, gridLabel } from '../../site-format.js';

	let { data, form } = $props();

	let sshOpen = $state(false);
	let tab = $state('uebersicht');
	let pwCopied = $state(false);
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let pwCopiedTimer;

	async function copyCloudPassword() {
		if (!site.cloud_password) return;
		try {
			await navigator.clipboard.writeText(site.cloud_password);
			pwCopied = true;
			clearTimeout(pwCopiedTimer);
			pwCopiedTimer = setTimeout(() => (pwCopied = false), 2000);
		} catch {}
	}

	const tabs = [
		{ id: 'uebersicht', label: 'Übersicht' },
		{ id: 'fernwartung', label: 'Fernwartung' }
	];

	const site = $derived(data.site);
	const conn = $derived(connectionState(data.site));
	const status = $derived(data.site.status);
	const logs = $derived(Array.isArray(data.site.status.logs) ? data.site.status.logs : []);

	const dateFmt = new Intl.DateTimeFormat('de-AT', {
		timeZone: 'Europe/Vienna',
		dateStyle: 'medium',
		timeStyle: 'short'
	});
</script>

<svelte:head>
	<title>{site.name} | {data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-16">
		<header>
			<a
				href="/intern"
				class="text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
			>
				&larr; Zur Übersicht
			</a>
			<div class="mt-2 flex flex-wrap items-center gap-3">
				<h1 class="text-3xl font-bold tracking-tight">{site.name}</h1>
				<span class="flex items-center gap-1.5 text-sm {conn.text}">
					<span class="inline-block h-2.5 w-2.5 rounded-full {conn.dot}"></span>
					{conn.label}
				</span>
			</div>
			<p class="mt-1 text-stone-600 dark:text-stone-400">
				{site.member_name ?? 'Ohne Mitglied'} · {profileLabels[site.inverter_profile] ?? site.inverter_profile}{site.address ? ` · ${site.address}` : ''}
			</p>
			<p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
				{#if site.last_seen_at}
					Letzter Status-Push: {seenLabel(site)} ({dateFmt.format(new Date(site.last_seen_at))})
				{:else}
					Noch kein Status-Push: Die Anlage meldet sich, sobald der Raspberry Pi mit der SD-Karte startet.
				{/if}
			</p>
		</header>

		{#if !site.online && site.last_seen_at}
			<p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
				Keine Meldung seit über 10 Minuten. Die Werte unten stammen vom letzten Status-Push und können veraltet sein.
			</p>
		{/if}

		<nav class="flex gap-6 border-b border-stone-200 dark:border-stone-800" aria-label="Bereiche">
			{#each tabs as t (t.id)}
				<button
					type="button"
					class="-mb-px border-b-2 px-1 pb-2 text-sm font-medium {tab === t.id
						? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
						: 'border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200'}"
					aria-current={tab === t.id ? 'page' : undefined}
					onclick={() => (tab = t.id)}
				>
					{t.label}
				</button>
			{/each}
		</nav>

		<!-- Beide Tab-Inhalte bleiben gemountet (nur per CSS versteckt), damit eine
		     offene SSH-Sitzung den Tab-Wechsel uebersteht. -->
		<div class={tab === 'uebersicht' ? 'flex flex-col gap-6' : 'hidden'}>
			{#if site.setup_phase !== 'fertig' || site.code_valid}
				<section class="rounded-lg border border-brand-300 bg-brand-50 p-5 dark:border-brand-700 dark:bg-brand-950/40">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<h2 class="text-lg font-semibold">Einrichtung: {site.setup_label}</h2>
						<span class="text-xs text-stone-600 dark:text-stone-400">{site.setup_percent}%{site.setup_phase_at ? ` · ${dateFmt.format(new Date(site.setup_phase_at))}` : ''}</span>
					</div>
					<div class="mt-2 h-2 rounded-full bg-stone-200 dark:bg-stone-800">
						<div class="h-2 rounded-full {site.setup_phase === 'fertig' ? 'bg-green-500' : 'bg-brand-500'}" style="width: {site.setup_percent}%"></div>
					</div>
					{#if site.setup_message}
						<p class="mt-2 font-mono text-xs text-stone-700 dark:text-stone-300">{site.setup_message}</p>
					{/if}
					<div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
						{#if site.code_valid}
							<span>Einrichtungscode <code class="rounded bg-white px-2 py-0.5 font-mono tracking-widest dark:bg-stone-950">{site.provision_code}</code> gültig bis {new Date(site.provision_expires_at).toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}</span>
						{:else}
							<span class="text-stone-600 dark:text-stone-400">Kein gültiger Einrichtungscode.</span>
						{/if}
						<form method="POST" action="?/code_erneuern">
							<button class="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900">Neuer Code</button>
						</form>
					</div>
					<div class="mt-4">
						<SdImage siteId={site.id} image={site.image} codeValid={site.code_valid} />
					</div>
					{#if site.metering_point}
						<p class="mt-3 text-xs text-stone-600 dark:text-stone-400">Zählpunkt: {site.point_direction === 'generation' ? 'Erzeugung' : 'Verbrauch'} {site.metering_point}</p>
					{/if}
				</section>
			{/if}

			{#if site.setup_phase !== 'fertig' || site.has_inverter_secret}
				<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900 {site.setup_phase === 'wartet_auf_passwort' ? 'border-amber-400 dark:border-amber-600' : ''}">
					<h2 class="text-lg font-semibold">Zugang zum Wechselrichter</h2>
					<p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
						Manche Wechselrichter (z. B. Fronius GEN24) brauchen für die Batteriesteuerung Benutzer und Passwort.
						Das Gateway holt die Angaben einmalig ab; danach wird das Passwort hier gelöscht und liegt nur noch auf dem Gateway.
					</p>
					{#if site.setup_phase === 'wartet_auf_passwort'}
						<p class="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
							Die Einrichtung wartet gerade auf dieses Passwort.
						</p>
					{/if}
					{#if form?.secret_saved}
						<p class="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
							Gespeichert. Das Gateway holt das Passwort innerhalb weniger Minuten ab.
						</p>
					{:else if site.has_inverter_secret}
						<p class="mt-2 text-sm text-stone-600 dark:text-stone-400">Ein Passwort ist hinterlegt und wartet auf die Abholung durch das Gateway.</p>
					{/if}
					{#if form?.message}
						<p class="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{form.message}</p>
					{/if}
					<form method="POST" action="?/wechselrichter_zugang" class="mt-3 flex flex-wrap items-end gap-3">
						<label class="block text-sm">
							<span class="text-stone-600 dark:text-stone-400">Benutzer</span>
							<input name="username" value={site.inverter_username ?? 'customer'} autocomplete="off"
								class="mt-1 block rounded-md border border-stone-300 bg-white px-3 py-1.5 dark:border-stone-700 dark:bg-stone-950" />
						</label>
						<label class="block text-sm">
							<span class="text-stone-600 dark:text-stone-400">Passwort</span>
							<input name="password" type="password" autocomplete="new-password"
								class="mt-1 block rounded-md border border-stone-300 bg-white px-3 py-1.5 dark:border-stone-700 dark:bg-stone-950" />
						</label>
						<button class="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
							Speichern
						</button>
					</form>
				</section>
			{/if}

			<div class="grid gap-4 md:grid-cols-2">
				<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
					<h2 class="text-lg font-semibold">Batterie</h2>
					{#if typeof status.soc === 'number'}
						<div class="mt-3">
							<div class="flex justify-between text-sm text-stone-600 dark:text-stone-400">
								<span>Ladestand</span>
								<span>{Math.round(status.soc)}%{typeof status.batterie_kapazitaet === 'number' ? ` von ${de(status.batterie_kapazitaet)} kWh` : ''}</span>
							</div>
							<div class="mt-1.5 h-3 rounded-full bg-stone-200 dark:bg-stone-800">
								<div
									class="h-3 rounded-full {status.soc > 25 ? 'bg-green-500' : 'bg-amber-500'}"
									style="width: {Math.min(100, Math.max(0, status.soc))}%"
								></div>
							</div>
						</div>
					{:else}
						<p class="mt-3 text-sm text-stone-500 dark:text-stone-400">Kein Ladestand gemeldet.</p>
					{/if}
					<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
						<dt class="text-stone-500 dark:text-stone-400">Kapazität</dt>
						<dd class="font-medium">{typeof status.batterie_kapazitaet === 'number' ? `${de(status.batterie_kapazitaet)} kWh` : 'k.A.'}</dd>
						<dt class="text-stone-500 dark:text-stone-400">Entladegrenze</dt>
						<dd class="font-medium">{typeof status.min_battery_charge === 'number' ? `${status.min_battery_charge}%` : 'k.A.'}</dd>
						<dt class="text-stone-500 dark:text-stone-400">Ladesperre</dt>
						<dd class="font-medium">{status.ladesperre_aktiv === 'ON' ? 'Aktiv' : 'Inaktiv'}</dd>
					</dl>
					{#if status.ladesperre_aktiv === 'ON'}
						<p class="mt-3 rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-800 dark:bg-brand-950 dark:text-brand-300">
							Ladesperre aktiv: Batterie wartet auf die Mittagsspitze
						</p>
					{/if}
				</section>

				<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
					<h2 class="text-lg font-semibold">Leistung</h2>
					<dl class="mt-3 grid grid-cols-2 gap-3">
						<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
							<dt class="text-xs text-stone-500 dark:text-stone-400">PV-Erzeugung</dt>
							<dd class="mt-1 text-lg font-semibold">{watt(status.pv_power_w) ?? 'k.A.'}</dd>
						</div>
						<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
							<dt class="text-xs text-stone-500 dark:text-stone-400">Hausverbrauch</dt>
							<dd class="mt-1 text-lg font-semibold">{watt(status.load_power_w) ?? 'k.A.'}</dd>
						</div>
						<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
							<dt class="text-xs text-stone-500 dark:text-stone-400">Batterie</dt>
							<dd class="mt-1 text-lg font-semibold">{batteryLabel(status)}</dd>
						</div>
						<div class="rounded-md bg-stone-50 p-3 dark:bg-stone-800/60">
							<dt class="text-xs text-stone-500 dark:text-stone-400">Netz</dt>
							<dd class="mt-1 text-lg font-semibold">{gridLabel(status)}</dd>
						</div>
					</dl>
				</section>

				<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900 md:col-span-2">
					<h2 class="text-lg font-semibold">Gateway</h2>
					<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
						<div>
							<dt class="text-stone-500 dark:text-stone-400">openHABian</dt>
							<dd class="mt-0.5 font-medium">{status.openhabian_version ?? 'k.A.'}</dd>
						</div>
						<div>
							<dt class="text-stone-500 dark:text-stone-400">openHAB</dt>
							<dd class="mt-0.5 font-medium">{status.openhab_version ?? 'k.A.'}</dd>
						</div>
						<div>
							<dt class="text-stone-500 dark:text-stone-400">Wechselrichter</dt>
							<dd class="mt-0.5 font-medium">{status.inverter_status === 'running' ? 'Läuft' : status.inverter_status ?? 'k.A.'}</dd>
						</div>
						<div>
							<dt class="text-stone-500 dark:text-stone-400">Hauptschalter</dt>
							<dd class="mt-0.5 font-medium">{status.hauptschalter === 'ON' ? 'Ein' : status.hauptschalter === 'OFF' ? 'Aus' : 'k.A.'}</dd>
						</div>
					</dl>
					<div class="mt-4 border-t border-stone-200 pt-4 dark:border-stone-800">
						<h3 class="font-medium">Cloud-Konto</h3>
						{#if site.cloud_username}
							<p class="mt-1 flex flex-wrap items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
								<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono dark:bg-stone-800">{site.cloud_username}</code>
								{#if site.cloud_password}
									<button
										type="button"
										class="rounded-md border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
										onclick={copyCloudPassword}
									>
										{pwCopied ? 'Kopiert' : 'Passwort kopieren'}
									</button>
								{/if}
							</p>
							<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
								{#if site.cloud_account_state === 'created'}
									Konto angelegt. Login für App und Browser; Fernzugriff auf die Main UI über die Stromkreis-Cloud.
								{:else if site.cloud_account_state === 'pending' || site.cloud_account_state === 'reset'}
									Konto wird gerade angelegt bzw. das Passwort gesetzt (bis zu 1 Minute).
								{:else if site.cloud_account_state === 'error'}
									<span class="text-red-600 dark:text-red-400">Fehler: {site.cloud_account_error}</span>
								{:else}
									Zustand: {site.cloud_account_state || 'unbekannt'}
								{/if}
							</p>
							{#if form?.cloud_password_reset}
								<p class="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
									Neues Passwort erzeugt; es wird innerhalb einer Minute gesetzt.
								</p>
							{/if}
							<form method="POST" action="?/cloud_passwort_neu" class="mt-2">
								<button class="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900">
									Neues Cloud-Passwort
								</button>
							</form>
						{:else}
							<p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Noch kein Cloud-Konto: wird bei der Einrichtung angelegt.</p>
						{/if}
					</div>
				</section>
			</div>
		</div>

		<div class={tab === 'fernwartung' ? 'flex flex-col gap-6' : 'hidden'}>
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<h2 class="text-lg font-semibold">SSH-Fernwartung</h2>
				{#if site.wg_address}
					<p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
						Tunnel-IP <code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono dark:bg-stone-800">{site.wg_address}</code>
						· {site.wg_key_reported ? 'Schlüssel gemeldet, Tunnel wird gehalten' : 'Wartet auf die erste Meldung des Gateways'}
					</p>
					<p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
						Zugriff vom Server: <code class="font-mono">deploy/wg-ssh.sh {site.wg_address}</code> (Anmeldung als openhabian mit dem Anlagen-Passwort)
					</p>
					{#if site.wg_key_reported && !sshOpen}
						<button
							type="button"
							class="mt-3 rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
							onclick={() => (sshOpen = true)}
						>
							SSH-Konsole öffnen
						</button>
					{/if}
					{#if sshOpen}
						<div class="mt-4">
							<SshTerminal siteId={site.id} onclose={() => (sshOpen = false)} />
						</div>
					{/if}
				{:else}
					<p class="mt-1 text-sm text-stone-500 dark:text-stone-400">Noch keine Tunnel-IP: wird bei der Einrichtung zugeteilt.</p>
				{/if}
			</section>

			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<h2 class="text-lg font-semibold">Protokoll</h2>
				<p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
					Letzte Zeilen aus openhab.log, übertragen mit dem Status-Push
				</p>
				{#if logs.length === 0}
					<p class="mt-4 text-sm text-stone-500 dark:text-stone-400">Keine Protokollzeilen übertragen.</p>
				{:else}
					<div class="mt-4 max-h-80 overflow-y-auto rounded-md bg-stone-950 p-3 font-mono text-xs leading-relaxed text-stone-300">
						{#each logs as line, i (i)}
							<p class="whitespace-pre-wrap">
								<span class="text-stone-500">{line.ts}</span>
								<span class={line.level === 'ERROR' ? 'text-red-400' : line.level === 'WARN' ? 'text-amber-400' : 'text-green-400'}>[{line.level}]</span>
								<span class="text-sky-400">[{line.logger}]</span>
								- {line.msg}
							</p>
						{/each}
					</div>
				{/if}
			</section>
		</div>

	</main>
</div>
