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

    // die API liefert 404 mit einem error-Feld, solange die KW keine Daten hat
    if (!jsonData.crossover) {
      console.error("[Stromkreis] Fehler: Keine Crossover-Daten fuer die aktuelle Kalenderwoche.");
    } else {
      var start = jsonData.crossover.avg_morning_crossover;
      var ende = jsonData.crossover.avg_evening_crossover;

      // 3. Werte in die String-Items schreiben
      items.getItem("Stromkreis_Crossover_Start").postUpdate(start);
      items.getItem("Stromkreis_Crossover_Ende").postUpdate(ende);
      console.log("[Stromkreis] Crossover aktualisiert (KW " + jsonData.crossover.week_number + "): " + start + " - " + ende);
    }
  } catch (e) {
    console.error("[Stromkreis] Fehler beim Parsen der Antwort: " + e.message);
  }
} else {
  console.error("[Stromkreis] Fehler: Keine Antwort von der API erhalten.");
}
