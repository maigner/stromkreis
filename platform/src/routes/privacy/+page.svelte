<script>
	import LegalPage from '$lib/LegalPage.svelte';
	import { operator, legalUpdated } from '$lib/legal.js';
</script>

<LegalPage title="Privacy Policy" lang="en">
	<p>
		This is the privacy policy of the Stromkreis platform (stromkreis.net) and the Stromkreis app.
		The authoritative version is the German <a href="/datenschutz">Datenschutzerklärung</a>.
	</p>

	<section>
		<h2>1. Controller</h2>
		<p>
			{operator.name}<br />
			{operator.street}, {operator.city}, {operator.countryEn}<br />
			Email: <a href="mailto:{operator.email}">{operator.email}</a>
		</p>
	</section>

	<section>
		<h2>2. Platform and energy communities</h2>
		<p>
			Stromkreis is a non-profit, open-source platform for Austrian renewable energy communities
			(EEGs). For their members' data (metering points, meter readings, battery sites) the respective
			energy community remains the controller; Stromkreis processes this data as a processor under a
			data processing agreement with the community. For website visits and platform logins we are the
			controller ourselves.
		</p>
	</section>

	<section>
		<h2>3. Stromkreis app</h2>
		<p>The app shows the status of the battery gateway at your home. It processes:</p>
		<ul>
			<li>
				<b>Setup code:</b> a one-time code from your energy community, sent once to stromkreis.net to
				obtain the login credentials for your remote access account.
			</li>
			<li>
				<b>Remote access account:</b> username and password for our openHAB Cloud service
				(hac.stromkreis.net), stored on your device and used to connect to your gateway.
			</li>
			<li>
				<b>Gateway data:</b> battery state of charge, power values (PV, battery, grid, household) and
				settings of your system, displayed in the app.
			</li>
		</ul>
		<p>
			The app contains no advertising and no analytics or tracking services. No data is sold or
			shared with third parties for marketing. Data is transmitted encrypted (HTTPS).
		</p>
	</section>

	<section>
		<h2>4. Website, login and cookies</h2>
		<p>
			Our web server processes your IP address, time of access, requested address and browser
			identifier to deliver the website and defend against attacks (Art. 6(1)(f) GDPR); these logs
			are kept only briefly. Public pages set no cookies. Logging in sets strictly necessary cookies
			only (a session cookie valid for 30 days and short-lived cookies protecting the login flow).
			Community operators log in with their EEG-Faktura account; we receive an account identifier,
			name, email address and the communities they may access, and store the access token encrypted.
		</p>
	</section>

	<section>
		<h2>5. Energy and gateway data</h2>
		<p>
			On behalf of the energy community, Stromkreis imports member data (name, address, metering
			points) and 15-minute meter readings from EEG-Faktura to provide analyses and forecasts.
			Gateways report their latest status (state of charge, power values, software versions, log
			lines) and connect to our server via an encrypted WireGuard tunnel for fixed maintenance
			actions. Member addresses are geocoded via OpenStreetMap Nominatim (United Kingdom, covered by
			an EU adequacy decision). Maps in the logged-in area load tiles from OpenFreeMap; weather data
			comes from Open-Meteo using only the community's location.
		</p>
		<p>
			The platform, database and remote access service run on our own infrastructure. Apart from the
			geocoding mentioned above, no data is transferred outside the EU/EEA.
		</p>
	</section>

	<section>
		<h2>6. Retention</h2>
		<ul>
			<li>Sessions: 30 days; one-time login links: at most 7 days.</li>
			<li>Server logs: briefly, for troubleshooting and security.</li>
			<li>
				Member, energy and gateway data: as long as the energy community uses the platform, or until
				deleted on its instruction.
			</li>
			<li>
				App credentials: stored on your device until you remove the app or its account.
			</li>
		</ul>
	</section>

	<section>
		<h2>7. Your rights</h2>
		<p>
			You have the right of access, rectification, erasure, restriction of processing, data
			portability and objection (Art. 15 to 21 GDPR). Contact
			<a href="mailto:{operator.email}">{operator.email}</a> or, for data from your membership, your
			energy community. You may lodge a complaint with the Austrian Data Protection Authority
			(Datenschutzbehörde, Barichgasse 40-42, 1030 Vienna, <a href="https://www.dsb.gv.at"
				>www.dsb.gv.at</a
			>).
		</p>
	</section>

	<p class="text-sm text-stone-500">Last updated: {legalUpdated.en}</p>
</LegalPage>
