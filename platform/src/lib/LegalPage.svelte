<script>
	/** @type {{ title: string, lang?: string, children: import('svelte').Snippet }} */
	let { title, lang = 'de', children } = $props();
</script>

<svelte:head>
	<title>{title} | Stromkreis</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100" {lang}>
	<main class="mx-auto max-w-3xl px-6 py-12">
		<a href="/" class="flex items-center gap-3 text-stone-700 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white">
			<svg viewBox="0 0 32 32" class="h-8 w-8 shrink-0" aria-hidden="true">
				<circle cx="16" cy="16" r="13" fill="none" stroke="#f59e0b" stroke-width="3" />
				<path fill="#f59e0b" d="M17.8 7.5 10.8 18h4.4l-1.6 6.5L20.8 14h-4.4z" />
			</svg>
			<span class="text-lg font-semibold">Stromkreis</span>
		</a>

		<h1 class="mt-10 text-3xl font-bold tracking-tight">{title}</h1>

		<div
			class="mt-8 space-y-8 text-stone-700 dark:text-stone-300 [&_a]:font-medium [&_a]:text-brand-600 [&_a:hover]:underline dark:[&_a]:text-brand-500 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-stone-900 dark:[&_h2]:text-stone-100 [&_li]:mt-1 [&_p+p]:mt-2 [&_ul]:mt-2 [&_ul]:ml-5 [&_ul]:list-disc"
		>
			{@render children()}
		</div>

		<footer class="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-stone-200 pt-6 text-sm text-stone-500 dark:border-stone-800">
			<a href="/" class="hover:underline">{lang === 'en' ? 'Home' : 'Startseite'}</a>
			<a href="/impressum" class="hover:underline">Impressum</a>
			<a href="/datenschutz" class="hover:underline">Datenschutz</a>
			<a href="/privacy" class="hover:underline">Privacy (English)</a>
		</footer>
	</main>
</div>
