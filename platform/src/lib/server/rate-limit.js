// Einfache Bremse im Speicher (ein Plattform-Prozess): hoechstens `max`
// Treffer je Schluessel (meist die Client-Adresse) in einem gleitenden
// Fenster von `windowMs`. Nach einem Neustart ist alles vergessen, das ist
// hier in Ordnung: die Bremse soll Durchprobieren (Einrichtungscodes) und
// Massenabrufe (Demo-Codes auf /review) unwirtschaftlich machen, kein
// Buchfuehrungssystem sein.
//
// Hinter Caddy liefert getClientAddress() nur mit ADDRESS_HEADER=X-Forwarded-For
// (Compose-Datei) die echte Adresse; ohne Header teilen sich alle ein Kontingent.

/**
 * @param {{ max: number, windowMs: number }} opts
 */
export function createRateLimiter({ max, windowMs }) {
	/** @type {Map<string, number[]>} Zeitstempel der Treffer je Schluessel */
	const hits = new Map();

	/** @param {string} key */
	function recent(key) {
		const now = Date.now();
		const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
		if (list.length) hits.set(key, list);
		else hits.delete(key);
		// Gelegentlich aufraeumen, damit vergessene Schluessel nicht liegen bleiben
		if (hits.size > 1000) {
			for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
		}
		return list;
	}

	return {
		/** Ist der Schluessel gerade gesperrt? (zaehlt nicht) @param {string} key */
		limited(key) {
			return recent(key).length >= max;
		},
		/**
		 * Treffer zaehlen. true = abweisen (das Limit war vor diesem Treffer
		 * schon erreicht, er wird dann nicht mehr gezaehlt); die ersten `max`
		 * Treffer im Fenster gehen durch.
		 * @param {string} key
		 */
		hit(key) {
			const list = recent(key);
			if (list.length >= max) return true;
			list.push(Date.now());
			hits.set(key, list);
			return false;
		},
		/** Nur fuer Tests. */
		reset() {
			hits.clear();
		}
	};
}

/**
 * Client-Adresse fuer die Bremse; hinter einem Proxy ohne Adress-Header
 * (oder in Tests) ein gemeinsames Kontingent.
 * @param {{ getClientAddress: () => string }} event
 */
export function clientKey(event) {
	try {
		return event.getClientAddress() || 'unbekannt';
	} catch {
		return 'unbekannt';
	}
}
