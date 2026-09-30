<script>
	let { data } = $props();
</script>

<svelte:head>
	<title>App Review Demo Setup | Stromkreis</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-16">
		<header>
			<h1 class="text-3xl font-bold tracking-tight">Stromkreis app: demo setup</h1>
			<p class="mt-1 text-stone-600 dark:text-stone-400">
				For app review. The code below connects the app to a demo site with demo data.
				No account or password is needed.
			</p>
		</header>

		{#if data.available}
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<ol class="flex list-decimal flex-col gap-3 pl-5 text-sm text-stone-700 dark:text-stone-300">
					<li>Install and open the Stromkreis app.</li>
					<li>
						On the setup screen, scan this QR code with the app. The app connects to the demo
						site {data.site_name} on its own.
					</li>
					<li>
						If this page is open on the test device itself, tap <strong>Open in the app</strong>
						instead.
					</li>
				</ol>
				<div class="mt-6 flex justify-center">
					<div class="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 dark:ring-stone-700">
						<div class="h-52 w-52 [&_svg]:h-full [&_svg]:w-full">
							{@html data.qr}
						</div>
					</div>
				</div>
				<div class="mt-6 flex flex-col items-start gap-3">
					<a
						href={data.app_link}
						class="inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
					>
						Open in the app
					</a>
					<p class="text-sm text-stone-700 dark:text-stone-300">Setup link:</p>
					<a
						href={data.link}
						class="max-w-full break-all rounded bg-stone-100 px-2 py-1 font-mono text-xs text-brand-600 hover:underline dark:bg-stone-800 dark:text-brand-500"
					>{data.link}</a>
				</div>
				<p class="mt-4 text-xs text-stone-500 dark:text-stone-400">
					Each code works once and is valid for {data.valid_hours} hours. Reload this page to get
					a new code.
				</p>
			</section>
		{:else}
			<section class="rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
				<p class="text-sm text-stone-700 dark:text-stone-300">
					{#if data.rate_limited}
						Too many codes were requested from this address. Please wait a few minutes and reload.
					{:else}
						The demo setup is not available right now. Please try again later.
					{/if}
				</p>
			</section>
		{/if}
	</main>
</div>
