// Crossover-Zeiten der Gemeinschaft von der Plattform holen. Der Endpunkt
// ist mandantenbezogen und braucht den Anlagen-Token (POST, damit der Token
// in keinem Access-Log landet).
var url = "https://stromkreis.net/api/gateway/crossover/v1";
var response = actions.HTTP.sendHttpPostRequest(url, "application/json",
  JSON.stringify({ token: '@GW_STATUS_TOKEN@' }), 5000);

// 2. Antwort verarbeiten
if (response !== null) {
  try {
    var jsonData = JSON.parse(response);

    // Die Plattform liefert 404 mit error-Feld und crossover=null, wenn die
    // letzten vollstaendigen Messtage keine Crossover-Zeiten haben (Winter:
    // die Gemeinschaft kommt nie ins Plus). Dann duerfen nicht die Werte der
    // letzten Woche mit Daten weiterleben: beide Items auf '-', die Steuerung
    // entlaedt ohne plausible Crossover-Zeiten nicht (core.js). Antwortet die
    // Plattform gar nicht, unlesbar oder mit einem anderen Fehler (z. B.
    // Token abgelehnt), bleiben die Werte stehen; core.js verwirft sie ueber
    // Stromkreis_Crossover_Zeit nach 14 Tagen von selbst.
    if (!jsonData.crossover) {
      if (typeof jsonData.error === "string" && jsonData.crossover === null) {
        console.log("[Stromkreis] Keine Crossover-Zeiten in den letzten Messtagen (" + jsonData.error + ") - Crossover geloescht");
        items.getItem("Stromkreis_Crossover_Start").postUpdate("-");
        items.getItem("Stromkreis_Crossover_Ende").postUpdate("-");
        try {
          items.getItem("Stromkreis_Crossover_Zeit").postUpdate(time.ZonedDateTime.now().toString());
        } catch (e1) {
          // Item fehlt bei aelteren Installationen
        }
      } else {
        console.error("[Stromkreis] Fehler: Antwort ohne Crossover-Daten"
          + (typeof jsonData.error === "string" ? " (" + jsonData.error + ")" : "") + " - Items bleiben unveraendert.");
      }
    } else {
      var start = jsonData.crossover.avg_morning_crossover;
      var ende = jsonData.crossover.avg_evening_crossover;

      // 3. Werte in die String-Items schreiben, Abrufzeit fuer die
      //    Alterspruefung der Steuerung mitschreiben
      items.getItem("Stromkreis_Crossover_Start").postUpdate(start);
      items.getItem("Stromkreis_Crossover_Ende").postUpdate(ende);
      try {
        items.getItem("Stromkreis_Crossover_Zeit").postUpdate(time.ZonedDateTime.now().toString());
      } catch (e2) {
        // Item fehlt bei aelteren Installationen - Setup-Skript 03 erneut ausfuehren
      }
      console.log("[Stromkreis] Crossover aktualisiert (KW " + jsonData.crossover.week_number + "): " + start + " - " + ende);
    }
  } catch (e) {
    console.error("[Stromkreis] Fehler beim Parsen der Antwort: " + e.message);
  }
} else {
  console.error("[Stromkreis] Fehler: Keine Antwort von der API erhalten.");
}
