<script>
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';

	let { data } = $props();

	const site = $derived(data.site);
	const host = $derived(
		data.site.name
			.toLowerCase()
			.replace(/ä/g, 'ae')
			.replace(/ö/g, 'oe')
			.replace(/ü/g, 'ue')
			.replace(/ß/g, 'ss')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '')
	);
	const prompt = $derived(`openhabian@${host}:~$`);

	/** @type {{text: string, cls?: string}[]} */
	let lines = $state([]);
	let cmd = $state('');
	let ready = $state(false);
	let ended = $state(false);
	/** @type {HTMLInputElement | undefined} */
	let inputEl = $state();
	/** @type {HTMLDivElement | undefined} */
	let termEl = $state();

	const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

	async function push(/** @type {string} */ text, /** @type {string | undefined} */ cls = undefined) {
		lines.push({ text, cls });
		await tick();
		if (termEl) termEl.scrollTop = termEl.scrollHeight;
	}

	onMount(async () => {
		await push(`$ ssh openhabian@${host}.local`, 'text-neutral-400');
		await sleep(400);
		if (!site.online) {
			await sleep(1100);
			await push(`ssh: connect to host ${host}.local port 22: Connection timed out`, 'text-red-400');
			await push('Die Anlage ist offline und über den Stromkreis-Tunnel nicht erreichbar.', 'text-neutral-500');
			ended = true;
			return;
		}
		await push(`Linux ${host} 6.6.31+rpt-rpi-v8 #1 SMP PREEMPT aarch64 GNU/Linux`);
		await push('');
		await push('###############################################');
		await push('    openHABian - hassle-free openHAB setup');
		await push('###############################################');
		await push(`openHAB ${site.status.openhab_version ?? '4.3.3'} · openHABian ${site.status.openhabian_version ?? '1.9.1'}`);
		await push('');
		await push("Tipp: 'help' zeigt die verfügbaren Befehle.", 'text-neutral-500');
		ready = true;
		await tick();
		inputEl?.focus();
	});

	function logLines() {
		const logs = Array.isArray(site.status.logs) ? site.status.logs : [];
		if (logs.length === 0) return ['(openhab.log ist leer)'];
		return logs.map(
			(/** @type {any} */ l) => `${l.ts} [${String(l.level).padEnd(5)}] [${l.logger}] - ${l.msg}`
		);
	}

	function outputs(/** @type {string} */ c) {
		if (c === 'help') {
			return [
				'Verfügbare Befehle (Demo):',
				'  uptime                    Laufzeit und Auslastung',
				'  free -h                   Speicherbelegung',
				'  df -h                     Dateisysteme',
				'  systemctl status openhab  Dienststatus',
				'  tail openhab.log          Letzte Protokollzeilen',
				'  clear                     Anzeige leeren',
				'  exit                      Sitzung beenden'
			];
		}
		if (c === 'uptime') {
			const days = 17 + (site.id % 40);
			return [` 21:32:01 up ${days} days,  4:12,  1 user,  load average: 0.24, 0.31, 0.28`];
		}
		if (c === 'free -h' || c === 'free') {
			return [
				'               total        used        free      shared  buff/cache   available',
				'Mem:           3.7Gi       1.9Gi       310Mi        42Mi       1.5Gi       1.6Gi',
				'Swap:          2.0Gi        86Mi       1.9Gi'
			];
		}
		if (c === 'df -h' || c === 'df') {
			return [
				'Filesystem      Size  Used Avail Use% Mounted on',
				'/dev/mmcblk0p2   29G  8.2G   20G  30% /',
				'/dev/mmcblk0p1  255M   62M  194M  25% /boot'
			];
		}
		if (c === 'systemctl status openhab') {
			const days = 17 + (site.id % 40);
			return [
				'● openhab.service - openHAB - empowering the smart home',
				'     Loaded: loaded (/lib/systemd/system/openhab.service; enabled)',
				`     Active: active (running) since ${days} days ago`,
				'   Main PID: 1163 (java)',
				'      Tasks: 142 (limit: 3910)',
				'     Memory: 812.4M',
				'        CPU: 4h 23min 11s'
			];
		}
		if (c.startsWith('tail') && c.includes('openhab.log')) {
			return logLines();
		}
		if (c === 'tail') {
			return ["tail: fehlendes Argument, meinten Sie 'tail openhab.log'?"];
		}
		return null;
	}

	async function run() {
		const c = cmd.trim();
		await push(`${prompt} ${cmd}`);
		cmd = '';
		if (!c) return;
		if (c === 'clear') {
			lines = [];
			return;
		}
		if (c === 'exit' || c === 'logout') {
			ready = false;
			ended = true;
			await push('Verbindung getrennt.', 'text-neutral-500');
			setTimeout(() => goto(`/intern/anlagen/${site.id}`), 800);
			return;
		}
		const out = outputs(c);
		if (out) {
			for (const l of out) await push(l);
		} else {
			await push(`-bash: ${c.split(' ')[0]}: command not found`, 'text-red-400');
		}
	}
</script>

<svelte:head>
	<title>Konsole {site.name} | {data.user.tenant_name} | Stromkreis</title>
</svelte:head>

<div class="min-h-screen bg-neutral-950 text-neutral-200">
	<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 px-6 py-10">
		<header class="flex flex-wrap items-center justify-between gap-2">
			<a
				href="/intern/anlagen/{site.id}"
				class="text-sm text-neutral-400 hover:text-neutral-200"
			>
				&larr; Zurück zu {site.name}
			</a>
			<span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-400">
				Demo-Mandant: simulierte SSH-Sitzung
			</span>
		</header>

		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			bind:this={termEl}
			onclick={() => inputEl?.focus()}
			class="max-h-[75dvh] flex-1 cursor-text overflow-y-auto rounded-lg border border-neutral-800 bg-black p-4 font-mono text-[13px] leading-relaxed"
		>
			{#each lines as line, i (i)}
				<p class="whitespace-pre-wrap {line.cls ?? ''}">{line.text || ' '}</p>
			{/each}
			{#if ready && !ended}
				<div class="flex gap-2">
					<span class="shrink-0 text-green-400">{prompt}</span>
					<input
						bind:this={inputEl}
						bind:value={cmd}
						onkeydown={(e) => e.key === 'Enter' && run()}
						class="w-full bg-transparent outline-none"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						aria-label="Befehl"
					/>
				</div>
			{/if}
		</div>
	</main>
</div>
