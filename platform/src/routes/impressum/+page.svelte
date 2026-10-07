<script>
	import LegalPage from '$lib/LegalPage.svelte';
	import { operator } from '$lib/legal.js';
</script>

<LegalPage title="Impressum">
	<section>
		<h2>Medieninhaber und Betreiber</h2>
		<p>
			{operator.name}<br />
			{operator.street}<br />
			{operator.city}, {operator.country}<br />
			E-Mail: <a href="mailto:{operator.email}">{operator.email}</a>
		</p>
	</section>

	<section>
		<h2>Offenlegung gemäß § 25 MedienG</h2>
		<p>
			Stromkreis ist eine gemeinnützige, quelloffene Plattform für Erneuerbare-Energie-Gemeinschaften
			in Österreich. Sie wird ohne Gewinnabsicht betrieben. Die Gründung eines gemeinnützigen
			Trägervereins ist vorgesehen; bis dahin ist die oben genannte Person Medieninhaber und Betreiber.
		</p>
		<p>
			Grundlegende Richtung: Information über die Plattform und Bereitstellung der Plattform für
			Energiegemeinschaften (Energiedaten, Prognosen, Batteriemanagement).
		</p>
	</section>

	<section>
		<h2>Quellcode und Lizenz</h2>
		<p>
			Der Quellcode der Plattform steht unter der GNU Affero General Public License, Version 3
			(AGPL-3.0).
		</p>
	</section>

	<section>
		<h2>Haftung für Inhalte und Links</h2>
		<p>
			Die Inhalte dieser Website wurden mit größtmöglicher Sorgfalt erstellt. Für Richtigkeit,
			Vollständigkeit und Aktualität kann jedoch keine Gewähr übernommen werden. Prognosen und
			Auswertungen sind Schätzungen und ersetzen nicht die Abrechnung der Energiegemeinschaft.
		</p>
		<p>
			Für die Inhalte externer Websites, auf die verlinkt wird, sind ausschließlich deren Betreiber
			verantwortlich. Sollten Sie auf rechtswidrige Inhalte oder Links aufmerksam werden, bitten wir
			um einen Hinweis an <a href="mailto:{operator.email}">{operator.email}</a>; betroffene Inhalte
			werden umgehend entfernt (§ 17 Abs. 2 ECG).
		</p>
	</section>

	<section>
		<h2>Datenschutz</h2>
		<p>
			Informationen zur Verarbeitung personenbezogener Daten finden Sie in der
			<a href="/datenschutz">Datenschutzerklärung</a>.
		</p>
	</section>
</LegalPage>
