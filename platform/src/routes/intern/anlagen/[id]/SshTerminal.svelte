<script>
	// Echte SSH-Konsole auf das Gateway: xterm.js im Browser, die Verbindung
	// haelt die Plattform (SSE fuer die Ausgabe, POST fuer die Eingabe).
	import { onMount } from 'svelte';
	import '@xterm/xterm/css/xterm.css';

	let { siteId, onclose = () => {} } = $props();

	let container = $state(/** @type {HTMLDivElement | null} */ (null));
	let status = $state('Verbinde ...');
	let failed = $state(false);

	const base = () => `/intern/anlagen/${siteId}/ssh`;

	/** @param {Uint8Array} bytes */
	function toB64(bytes) {
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin);
	}
	/** @param {string} b64 */
	function fromB64(b64) {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}

	onMount(() => {
		let disposed = false;
		/** @type {EventSource | null} */
		let source = null;
		/** @type {string} */
		let sid = '';
		/** @type {import('@xterm/xterm').Terminal | null} */
		let term = null;
		/** @type {ResizeObserver | null} */
		let observer = null;
		const encoder = new TextEncoder();

		// Eingaben sammeln und gebuendelt schicken (ein POST je ~15 ms statt je Taste)
		/** @type {Uint8Array[]} */
		let pending = [];
		/** @type {ReturnType<typeof setTimeout> | null} */
		let flushTimer = null;
		let sending = false;
		async function flush() {
			flushTimer = null;
			if (sending || !pending.length || !sid) return;
			const chunks = pending;
			pending = [];
			const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
			let off = 0;
			for (const c of chunks) {
				total.set(c, off);
				off += c.length;
			}
			sending = true;
			try {
				await fetch(`${base()}/input`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sid, data: toB64(total) })
				});
			} catch {}
			sending = false;
			if (pending.length) flush();
		}
		/** @param {Uint8Array} bytes */
		function queue(bytes) {
			pending.push(bytes);
			if (!flushTimer) flushTimer = setTimeout(flush, 15);
		}

		async function start() {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit')
			]);
			if (disposed || !container) return;
			term = new Terminal({
				fontSize: 13,
				fontFamily: "ui-monospace, 'Cascadia Mono', 'JetBrains Mono', Menlo, monospace",
				cursorBlink: true,
				scrollback: 5000
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(container);
			fit.fit();

			const res = await fetch(base(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cols: term.cols, rows: term.rows })
			});
			const opened = await res.json().catch(() => ({}));
			if (!res.ok || !opened.id) {
				status = opened.error || 'SSH-Verbindung fehlgeschlagen.';
				failed = true;
				return;
			}
			sid = opened.id;
			status = '';

			source = new EventSource(`${base()}/stream?sid=${encodeURIComponent(sid)}`);
			source.onmessage = (e) => term?.write(fromB64(e.data));
			source.addEventListener('end', () => {
				status = 'Sitzung beendet.';
				source?.close();
				source = null;
			});
			source.onerror = () => {
				if (!disposed && status === '') status = 'Verbindung unterbrochen.';
			};

			term.onData((data) => queue(encoder.encode(data)));
			term.onBinary((data) => queue(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)));

			/** @type {ReturnType<typeof setTimeout> | null} */
			let resizeTimer = null;
			observer = new ResizeObserver(() => {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					if (disposed || !term) return;
					fit.fit();
					fetch(`${base()}/input`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sid, resize: { cols: term.cols, rows: term.rows } })
					}).catch(() => {});
				}, 150);
			});
			observer.observe(container);
			term.focus();
		}
		start();

		return () => {
			disposed = true;
			observer?.disconnect();
			source?.close();
			if (sid) fetch(`${base()}?sid=${encodeURIComponent(sid)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
			term?.dispose();
		};
	});
</script>

<div class="overflow-hidden rounded-lg border border-stone-300 bg-[#000] dark:border-stone-700">
	<div class="flex items-center justify-between border-b border-stone-700 bg-stone-900 px-3 py-1.5">
		<span class="text-xs text-stone-300">
			SSH-Konsole
			{#if status}<span class={failed ? 'text-red-400' : 'text-stone-400'}> · {status}</span>{/if}
		</span>
		<button
			type="button"
			class="text-xs text-stone-400 hover:text-stone-200"
			onclick={() => onclose()}
		>Schließen</button>
	</div>
	<div bind:this={container} class="h-96 p-1.5"></div>
</div>
