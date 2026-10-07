<script>
	import LegalPage from '$lib/LegalPage.svelte';
	import { operator, legalUpdated } from '$lib/legal.js';
</script>

<LegalPage title="Datenschutzerklärung">
	<section>
		<h2>1. Verantwortlicher</h2>
		<p>
			{operator.name}<br />
			{operator.street}, {operator.city}, {operator.country}<br />
			E-Mail: <a href="mailto:{operator.email}">{operator.email}</a>
		</p>
		<p>
			Wir verarbeiten personenbezogene Daten ausschließlich auf Grundlage der gesetzlichen
			Bestimmungen (DSGVO, DSG). Diese Erklärung beschreibt, welche Daten die Plattform Stromkreis
			(stromkreis.net) und die Stromkreis-App verarbeiten.
		</p>
	</section>

	<section>
		<h2>2. Rollenverteilung: Plattform und Energiegemeinschaft</h2>
		<p>
			Stromkreis stellt Erneuerbare-Energie-Gemeinschaften (EEGs) eine Plattform für Energiedaten,
			Prognosen und Batteriemanagement bereit. Für die Daten ihrer Mitglieder (Zählpunkte,
			Messwerte, Anlagen) bleibt die jeweilige EEG Verantwortliche; Stromkreis verarbeitet diese
			Daten als Auftragsverarbeiter auf Grundlage eines Auftragsverarbeitungsvertrags mit der EEG.
			Als Mitglied einer EEG wenden Sie sich für Auskünfte zu diesen Daten bitte an Ihre EEG; wir
			unterstützen sie dabei.
		</p>
		<p>
			Für den Besuch der Website und die Anmeldung an der Plattform sind wir selbst Verantwortlicher.
		</p>
	</section>

	<section>
		<h2>3. Besuch der Website (Server-Logs)</h2>
		<p>
			Beim Aufruf der Website verarbeitet unser Webserver technisch bedingt Ihre IP-Adresse, Datum
			und Uhrzeit des Zugriffs, die aufgerufene Adresse und die Browser-Kennung. Diese Daten dienen
			der Bereitstellung der Website, der Fehleranalyse und der Abwehr von Angriffen (Art. 6 Abs. 1
			lit. f DSGVO) und werden nur kurzfristig gespeichert.
		</p>
	</section>

	<section>
		<h2>4. Cookies</h2>
		<p>
			Stromkreis verwendet keine Tracking- oder Analyse-Cookies und keine Werbedienste. Beim bloßen
			Besuch der öffentlichen Seiten werden keine Cookies gesetzt. Erst bei der Anmeldung werden
			technisch notwendige Cookies gesetzt: ein Sitzungs-Cookie (gültig 30 Tage) sowie kurzlebige
			Cookies zum Schutz des Anmeldevorgangs und zur Auswahl der Energiegemeinschaft. Diese Cookies
			sind für die Anmeldung erforderlich (Art. 6 Abs. 1 lit. b und f DSGVO) und bedürfen keiner
			Einwilligung.
		</p>
	</section>

	<section>
		<h2>5. Anmeldung</h2>
		<p>
			Betreiber von Energiegemeinschaften melden sich mit ihrem EEG-Faktura-Konto an. Dabei erhalten
			wir vom Anmeldedienst von EEG-Faktura eine Kennung Ihres Kontos, Ihren Namen, Ihre
			E-Mail-Adresse und die Energiegemeinschaften, für die Sie berechtigt sind. Mit Ihrer Anmeldung
			erteilen Sie Stromkreis Zugriff auf die Daten Ihrer Energiegemeinschaft in EEG-Faktura; das
			dafür ausgestellte Zugriffstoken speichern wir verschlüsselt. Alternativ erfolgt die Anmeldung
			über einen persönlichen Einmal-Link. Wir speichern Ihre Sitzung in unserer Datenbank (Art. 6
			Abs. 1 lit. b DSGVO).
		</p>
	</section>

	<section>
		<h2>6. Energiedaten aus EEG-Faktura</h2>
		<p>
			Im Auftrag der Energiegemeinschaft importiert Stromkreis aus EEG-Faktura die Teilnehmer
			(Name, Anschrift, Zählpunkte) und die Messwerte der Zählpunkte in Viertelstundenauflösung
			(Bezug, Einspeisung, Anteil an der gemeinschaftlichen Erzeugung). Daraus werden Auswertungen
			und Prognosen für die Gemeinschaft erstellt. Zugriff haben nur berechtigte Personen der
			jeweiligen Energiegemeinschaft; die Daten verschiedener Gemeinschaften sind technisch
			voneinander getrennt.
		</p>
		<p>
			Für die Kartendarstellung werden Mitgliedsadressen über den Dienst Nominatim der OpenStreetMap
			Foundation in Koordinaten umgewandelt (Sitz im Vereinigten Königreich, für das ein
			Angemessenheitsbeschluss der EU-Kommission besteht).
		</p>
	</section>

	<section>
		<h2>7. Batteriemanagement und Gateways</h2>
		<p>
			Mitglieder, die ihren Heimspeicher am Batteriemanagement ihrer Energiegemeinschaft teilnehmen
			lassen, erhalten ein Gateway. Dieses meldet regelmäßig den Zustand der Anlage an Stromkreis:
			Ladestand, Leistungswerte (PV, Batterie, Netz, Hausverbrauch), Software-Versionen und
			Protokollzeilen des Gateways. Gespeichert wird jeweils der letzte gemeldete Zustand. Für die
			Fernwartung baut das Gateway eine verschlüsselte Verbindung (WireGuard) zu unserem Server auf;
			über diese werden nur festgelegte Wartungsaktionen ausgeführt. Zweck ist die sichere Steuerung
			des Speichers im Sinne der Gemeinschaft (Art. 6 Abs. 1 lit. b DSGVO, im Auftrag der EEG).
		</p>
	</section>

	<section>
		<h2>8. Stromkreis-App</h2>
		<p>
			Die Stromkreis-App zeigt den Zustand Ihres Gateways an. Bei der Einrichtung lösen Sie einen
			Einrichtungscode ein; die App erhält damit die Zugangsdaten zu Ihrem Konto bei unserem
			Fernzugriffsdienst (openHAB Cloud unter hac.stromkreis.net), über den sie mit Ihrem Gateway
			kommuniziert. Die App enthält keine Werbung und keine Analyse- oder Tracking-Dienste. Weitere
			Informationen auf Englisch: <a href="/privacy">Privacy Policy</a>.
		</p>
	</section>

	<section>
		<h2>9. Externe Dienste</h2>
		<ul>
			<li>
				<b>EEG-Faktura</b> (Verein zur Förderung von Erneuerbaren-Energie-Gemeinschaften): Anmeldung
				und Quelle der Teilnehmer- und Energiedaten.
			</li>
			<li>
				<b>OpenFreeMap</b>: Kartenkacheln im angemeldeten Bereich, europäisch gehostet, ohne
				Nutzerverfolgung. Beim Laden der Karte wird technisch bedingt Ihre IP-Adresse übertragen.
			</li>
			<li>
				<b>Open-Meteo</b>: Wetterdaten für Prognosen; übertragen wird nur der Standort der
				Gemeinschaft, keine personenbezogenen Daten.
			</li>
			<li><b>OpenStreetMap Foundation (Nominatim)</b>: Geokodierung, siehe Abschnitt 6.</li>
		</ul>
		<p>
			Plattform, Datenbank und Fernwartung betreiben wir auf eigener Infrastruktur. Eine Übermittlung
			in Drittländer außerhalb der EU bzw. des EWR findet, abgesehen von der Geokodierung im
			Vereinigten Königreich, nicht statt.
		</p>
	</section>

	<section>
		<h2>10. Speicherdauer</h2>
		<ul>
			<li>Sitzungen: 30 Tage; Einmal-Links: höchstens 7 Tage.</li>
			<li>Server-Logs: kurzfristig, zur Fehleranalyse und Angriffsabwehr.</li>
			<li>
				Teilnehmer-, Energie- und Anlagendaten: solange die Energiegemeinschaft die Plattform nutzt
				bzw. bis zur Löschung auf Weisung der Energiegemeinschaft.
			</li>
		</ul>
	</section>

	<section>
		<h2>11. Ihre Rechte</h2>
		<p>
			Ihnen stehen die Rechte auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung
			(Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und
			Widerspruch (Art. 21) zu. Wenden Sie sich dazu an
			<a href="mailto:{operator.email}">{operator.email}</a> oder, für Daten aus Ihrer
			Mitgliedschaft, an Ihre Energiegemeinschaft.
		</p>
		<p>
			Wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer Daten gegen das Datenschutzrecht
			verstößt, können Sie sich bei der Österreichischen Datenschutzbehörde beschweren: Barichgasse
			40-42, 1030 Wien, <a href="https://www.dsb.gv.at">www.dsb.gv.at</a>.
		</p>
	</section>

	<p class="text-sm text-stone-500">Stand: {legalUpdated.de}</p>
</LegalPage>
