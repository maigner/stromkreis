// Bewoelkungsvorhersage von der Plattform holen. Der Endpunkt ist
// mandantenbezogen und braucht den Anlagen-Token (POST, damit der Token in
// keinem Access-Log landet).
var url = "https://stromkreis.net/api/gateway/wolken/v1";
var response = actions.HTTP.sendHttpPostRequest(url, "application/json",
  JSON.stringify({ token: '@GW_STATUS_TOKEN@' }), 5000);

// 2. Antwort verarbeiten
if (response !== null) {
  try {
    var jsonData = JSON.parse(response);

    // die API liefert 404 mit einem error-Feld, wenn keine Wetterdaten vorliegen
    if (!jsonData.wolken || typeof jsonData.wolken.vorschau !== "number") {
      console.error("[Stromkreis] Fehler: Keine Wolkenvorschau von der API erhalten" + (jsonData.error ? " (" + jsonData.error + ")" : "") + " - Item bleibt unveraendert.");
    } else {
      var value = jsonData.wolken.vorschau;

      if (value < 0 || value > 100) {
        console.error("[Stromkreis] Fehler: Wolkenvorschau ausserhalb 0-100 (" + value + ") - Item bleibt unveraendert.");
      } else {
        // 3. Wert in das Number-Item schreiben, Abrufzeit fuer die
        //    Aktualitaetspruefung der Steuerung mitschreiben
        items.getItem("Stromkreis_Wolkenvorschau").postUpdate(value);
        try {
          items.getItem("Stromkreis_Wolkenvorschau_Zeit").postUpdate(time.ZonedDateTime.now().toString());
        } catch (e2) {
          // Item fehlt bei aelteren Installationen - Steuerung laeuft dann ohne Aktualitaetspruefung
        }

        // 3b. Erwarteter Ertrag des Tages, dem die Vorschau gilt, als Anteil
        //     an einem guten Tag (Plattform: Strahlungsprognose durch das 75.
        //     Perzentil der 14 Vortage) - in Prozent ins Number-Item. NULL,
        //     wenn die Plattform keinen Wert liefert; die Nachtreserve rechnet
        //     dann mit dem Wolkenfaktor (core.js, nightReserve).
        var ertrag = null;
        if (jsonData.ertrag && typeof jsonData.ertrag.anteil === "number"
            && jsonData.ertrag.anteil >= 0 && jsonData.ertrag.anteil <= 3) {
          ertrag = Math.round(jsonData.ertrag.anteil * 100);
        }
        try {
          var ertragItem = items.getItem("Stromkreis_Ertragsprognose");
          if (ertrag === null) ertragItem.postUpdate("NULL"); else ertragItem.postUpdate(ertrag);
        } catch (e6) {
          // Item fehlt bei aelteren Installationen - Setup-Skript 03 erneut ausfuehren
        }

        // 4. Stundenwerte fuer den Rest des heutigen Tages (dynamische
        //    Laderegelung). Datum und Abrufzeit wandern mit ins JSON - die
        //    Steuerung verwirft veraltete oder fremde Tage selbst. '-' wenn
        //    der Server (noch) keine Stundenwerte liefert.
        var stundenText = "-";
        if (Array.isArray(jsonData.wolken.stunden) && jsonData.wolken.stunden.length > 0
            && typeof jsonData.wolken.datum === "string") {
          stundenText = JSON.stringify({
            datum: jsonData.wolken.datum,
            zeit: time.ZonedDateTime.now().toString(),
            stunden: jsonData.wolken.stunden
          });
        }
        try {
          items.getItem("Stromkreis_Wolken_Stunden").postUpdate(stundenText);
        } catch (e3) {
          // Item fehlt bei aelteren Installationen - Setup-Skript 03 erneut ausfuehren
        }

        // 5. Verlauf der letzten Abrufe (JSON-Liste von {zeit, wert, ertrag},
        //    aeltester zuerst): die Steuerung rechnet mit dem Mittel der
        //    letzten Abrufe statt mit dem letzten Wert allein, damit ein
        //    kurzer Wackler der Vorhersage die Nacht-Entladung nicht kippt
        //    (core.js, CLOUD_SMOOTH_FETCHES) - fuer Wolken und Ertrag
        //    gleichermassen. Ohne Item (Setup 03 nicht erneut ausgefuehrt)
        //    rechnet die Steuerung mit dem letzten Wert.
        try {
          var verlaufItem = items.getItem("Stromkreis_Wolken_Verlauf");
          var verlauf = [];
          try {
            var alt = JSON.parse(String(verlaufItem.state));
            if (Array.isArray(alt)) verlauf = alt;
          } catch (e4) {
            verlauf = [];
          }
          verlauf.push({ zeit: time.ZonedDateTime.now().toString(), wert: value, ertrag: ertrag });
          while (verlauf.length > 6) verlauf.shift();
          verlaufItem.postUpdate(JSON.stringify(verlauf));
        } catch (e5) {
          // Item fehlt bei aelteren Installationen - Setup-Skript 03 erneut ausfuehren
        }
        console.log("[Stromkreis] Wolkenvorschau aktualisiert: " + value
          + (ertrag === null ? ", keine Ertragsprognose" : ", Ertrag " + ertrag + "% eines guten Tages")
          + (stundenText === "-" ? "" : " (+" + jsonData.wolken.stunden.length + " Stundenwerte)"));
      }
    }
  } catch (e) {
    console.error("[Stromkreis] Fehler beim Parsen der Antwort: " + e.message);
  }
} else {
  console.error("[Stromkreis] Fehler: Keine Antwort von der API erhalten.");
}
