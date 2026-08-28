// ============================================================================
// Stromkreis - Wechselrichter-Adapter: Fronius GEN24 (Fronius-Binding)
//
// Definiert die drei Funktionen des Adapter-Kontrakts (siehe control/core.js)
// ueber die Batterie-Thing-Actions des openHAB-Fronius-Bindings. Die Actions
// legen selbst ablaufende Schedules an - nach `minutes` Minuten kehrt der
// Wechselrichter von allein zum Werksverhalten zurueck, auch wenn openHAB
// ausfaellt.
//
// KEIN gwLimitCharge: das Fronius-Binding bietet keine Action, die die
// Ladeleistung auf einen Wert begrenzt (nur Sperren, forciertes Laden und
// forciertes Entladen). Die Laderegelung des Kerns bildet die Begrenzung
// deshalb per PWM ueber gwPreventCharge nach - an der Schreibfrequenz
// aendert das nichts (auch bisher wurde im Fenster alle 5 Minuten ein
// Schedule gesetzt).
//
// Voraussetzung: Benutzername und Passwort des Wechselrichters im Bridge-
// Thing, sonst stellt das Binding die Batterie-Actions nicht bereit.
//
// Vom Setup ersetzt: @GW_THING_UID@ (Thing-UID des Wechselrichters).
// ============================================================================

var __gwFroniusActions = null;
try {
  __gwFroniusActions = actions.thingActions('fronius', '@GW_THING_UID@');
} catch (e) {
  __gwFroniusActions = null;
}
if (__gwFroniusActions === null || __gwFroniusActions === undefined) {
  console.log('[Stromkreis][Adapter] Fronius-Actions nicht verfuegbar - Credentials im Bridge-Thing pruefen');
}

// Die Actions liefern je nach Binding-Version boolean oder String.
function __gwOk(value) {
  return value === true || String(value) === 'true';
}

function gwReset() {
  if (__gwFroniusActions === null) return { ok: false };
  try {
    return { ok: __gwOk(__gwFroniusActions.resetBatteryControl()) };
  } catch (e) {
    console.log('[Stromkreis][Adapter] resetBatteryControl fehlgeschlagen: ' + e);
    return { ok: false };
  }
}

function gwPreventCharge(minutes) {
  if (__gwFroniusActions === null) return { ok: false };
  try {
    var from = time.ZonedDateTime.now();
    var until = from.plusMinutes(minutes);
    return { ok: __gwOk(__gwFroniusActions.addPreventBatteryChargingSchedule(from, until)) };
  } catch (e) {
    console.log('[Stromkreis][Adapter] addPreventBatteryChargingSchedule fehlgeschlagen: ' + e);
    return { ok: false };
  }
}

function gwForceDischarge(watts, minutes) {
  if (__gwFroniusActions === null) return { ok: false };
  try {
    var from = time.ZonedDateTime.now();
    var until = from.plusMinutes(minutes);
    var ok = __gwOk(__gwFroniusActions.addForcedBatteryDischargingSchedule(from, until, Quantity(watts + 'W')));
    return { ok: ok, appliedW: watts };
  } catch (e) {
    console.log('[Stromkreis][Adapter] addForcedBatteryDischargingSchedule fehlgeschlagen: ' + e);
    return { ok: false };
  }
}
