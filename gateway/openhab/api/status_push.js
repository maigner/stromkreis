// Sammelt den Zustand der Anlage und meldet ihn an die Plattform
// (Anlagenuebersicht auf stromkreis.net). Authentifiziert wird mit dem
// Anlagen-Token, das das Gateway bei der Einrichtung erhalten hat
// (gateway.conf).
//
// Die Regel laeuft minuetlich (CRON_STATUS): jede Meldung traegt die
// Momentanwerte (billige Item-Reads); der volle Zustand mit Log, Versionen,
// apt-Updates und Systemwerten geht nur in der Minute 2 jedes
// 5-Minuten-Rasters mit - die Sammler starten sonst unnoetig Prozesse auf
// dem Pi. Der Server erkennt volle Meldungen am Feld `versions`, mischt
// schlanke Meldungen in den letzten Stand und schreibt nur volle Meldungen
// in die Verlaufstabelle (die Diagramme bleiben so im 5-Minuten-Raster).
//
// Die @...@-Platzhalter ersetzt 04-install-rules.sh anlagenspezifisch.

var url = "https://stromkreis.net/api/gateway/status/v1";

var voll = (time.ZonedDateTime.now().minute() % 5) === 2;

// Itemzustand als String; null bei fehlendem Item oder NULL/UNDEF.
function stateOf(name) {
  try {
    var item = items.getItem(name);
    var state = String(item.state);
    return (state === "NULL" || state === "UNDEF") ? null : state;
  } catch (e) {
    return null;
  }
}

// Itemzustand als Zahl; Einheiten wie "78.5 %" werden mitgelesen.
function numberOf(name) {
  var state = stateOf(name);
  if (state === null) return null;
  var n = parseFloat(state);
  return isNaN(n) ? null : n;
}

// Erster numerischer Wert aus einer Liste von Kandidaten-Items. Die
// Leistungs-Items entstehen beim Verknuepfen der Channels in der Main UI
// und heissen daher nicht auf jeder Anlage gleich; fuer weitere
// Wechselrichter-Typen die ueblichen Itemnamen hier ergaenzen.
function firstNumberOf(names) {
  for (var i = 0; i < names.length; i++) {
    var n = numberOf(names[i]);
    if (n !== null) return n;
  }
  return null;
}

var inverterStatus = null;
try {
  var thing = things.getThing('@GW_THING_UID@');
  if (thing !== null && thing !== undefined) {
    inverterStatus = String(thing.status);
  }
} catch (e) {
  inverterStatus = null;
}

// Fehler und Warnungen der letzten 24 Stunden aus dem openHAB-Log fuer das
// Dashboard. Stacktrace-Folgezeilen haben keinen Zeitstempel und fallen
// durch das Muster; von den Treffern gehen die neuesten LOG_MAX_ENTRIES
// (gekuerzt) mit - zusammen bleibt das weit unter dem 16-KB-Limit des
// data-Felds auf dem Server.
var LOG_MAX_ENTRIES = 20;
var LOG_MAX_MESSAGE = 240;

function collectLogEntries() {
  var raw;
  try {
    raw = actions.Exec.executeCommandLine(
      time.Duration.ofSeconds(10),
      '/bin/sh', '-c',
      "grep -E '\\[(WARN |ERROR)\\]' '@GW_LOG_DIR@/openhab.log' | tail -n 100"
    );
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined) return [];

  // Log-Zeitstempel (Lokalzeit des Pi) sind lexikografisch sortierbar,
  // daher genuegt fuer das 24-Stunden-Fenster ein Stringvergleich.
  var cutoff = time.ZonedDateTime.now().minusHours(24)
    .format(time.DateTimeFormatter.ofPattern('yyyy-MM-dd HH:mm:ss'));
  var pattern = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+ \[(WARN |ERROR)\] \[([^\]]*?)\s*\] - (.*)$/;

  var entries = [];
  String(raw).split('\n').forEach(function (line) {
    var m = pattern.exec(line);
    if (m === null || m[1] < cutoff) return;
    var message = m[4];
    if (message.length > LOG_MAX_MESSAGE) {
      message = message.substring(0, LOG_MAX_MESSAGE) + '…';
    }
    entries.push({ time: m[1], level: m[2].trim(), logger: m[3], message: message });
  });
  return entries.slice(-LOG_MAX_ENTRIES);
}

// Versionsstaende fuer das Dashboard: das Gateway-Paket stempelt
// 04-install-rules.sh beim Rendern der Regel aus der BUILD-INFO des Pakets,
// openHAB-Kern und Java liefert die Runtime, das Betriebssystem
// /etc/os-release. Fehlendes bleibt null.
function collectVersions() {
  var versions = { gateway: '@GW_PAKET_VERSION@', openhab: null, openhabian: null, java: null, os: null };
  try {
    var ohb = actions.Exec.executeCommandLine(
      time.Duration.ofSeconds(5),
      '/bin/sh', '-c', 'git -C /opt/openhabian describe --tags --always 2>/dev/null'
    );
    if (ohb !== null && ohb !== undefined && String(ohb).trim().length > 0) {
      versions.openhabian = String(ohb).trim();
    }
  } catch (e) { }
  try {
    versions.openhab = String(Java.type('org.openhab.core.OpenHAB').getVersion());
  } catch (e) { }
  try {
    versions.java = String(Java.type('java.lang.System').getProperty('java.runtime.version'));
  } catch (e) { }
  try {
    var os = actions.Exec.executeCommandLine(
      time.Duration.ofSeconds(5),
      '/bin/sh', '-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"'
    );
    if (os !== null && os !== undefined && String(os).trim().length > 0) {
      versions.os = String(os).trim();
    }
  } catch (e) { }
  return versions;
}

// Ausstehende apt-Updates laut lokalem Paket-Cache. "apt-get -s" braucht
// weder root noch Sperren. Wie aktuell das Ergebnis ist, haengt vom letzten
// "apt-get update" ab - deshalb geht der Stand der Paketlisten (mtime von
// /var/lib/apt/lists) mit ans Dashboard.
function collectAptUpdates() {
  var raw;
  try {
    raw = actions.Exec.executeCommandLine(
      time.Duration.ofSeconds(60),
      '/bin/sh', '-c',
      "command -v apt-get >/dev/null 2>&1 || exit 0; " +
      "apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep -c '^Inst '; " +
      "date -r /var/lib/apt/lists '+%F %H:%M' 2>/dev/null"
    );
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  var lines = String(raw).trim().split('\n');
  var pending = parseInt(lines[0], 10);
  if (isNaN(pending) || pending < 0) return null;
  return {
    pending: pending,
    lists_updated: lines.length > 1 && lines[1].trim().length > 0 ? lines[1].trim() : null
  };
}

// Systemzustand des Pi fuer das Dashboard: CPU-Temperatur und das
// throttled-Register (meldet Unterspannung - der Klassiker bei schwachen
// Netzteilen, kuendigt SD-Karten-Schaeden an), Fuellstand der SD-Karte,
// Boot-Zeitpunkt, Speicherauslastung, ob ein Reboot ansteht (nach
// Kernel-Sicherheitsupdates) und wann unattended-upgrades zuletzt gelaufen
// ist. Alles ohne root lesbar; was ein System nicht hergibt, bleibt null.
function collectSystemHealth() {
  var raw;
  try {
    raw = actions.Exec.executeCommandLine(
      time.Duration.ofSeconds(10),
      '/bin/sh', '-c',
      'echo "temp:$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"; ' +
      // vcgencmd braucht die video-Gruppe; wo sie fehlt, liefert der Kernel
      // dasselbe Register unter /sys (dort ohne 0x-Praefix).
      'thr="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"; ' +
      '[ -n "$thr" ] || thr="0x$(cat /sys/devices/platform/soc/soc:firmware/get_throttled 2>/dev/null)"; ' +
      'echo "throttled:$thr"; ' +
      'echo "disk:$(df --output=pcent / 2>/dev/null | tail -n1 | tr -d " %")"; ' +
      'echo "boot:$(uptime -s 2>/dev/null)"; ' +
      'echo "mem:$(free -m 2>/dev/null | sed -n 2p)"; ' +
      'echo "swap:$(free -m 2>/dev/null | sed -n 3p)"; ' +
      'echo "reboot:$([ -e /run/reboot-required ] && echo 1 || echo 0)"; ' +
      // Stempel des letzten unattended-upgrades-Laufs (apt.systemd.daily);
      // das Logverzeichnis selbst ist meist nur fuer root/adm lesbar.
      'u="$(date -r /var/lib/apt/periodic/upgrade-stamp "+%F %H:%M" 2>/dev/null)"; ' +
      '[ -n "$u" ] || u="$(date -r /var/log/unattended-upgrades/unattended-upgrades.log "+%F %H:%M" 2>/dev/null)"; ' +
      'echo "upgrades:$u"'
    );
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined) return null;

  var values = {};
  String(raw).split('\n').forEach(function (line) {
    var sep = line.indexOf(':');
    if (sep > 0) values[line.substring(0, sep)] = line.substring(sep + 1).trim();
  });
  function intOf(text) {
    var n = parseInt(text, 10);
    return isNaN(n) ? null : n;
  }
  // free-Zeile "Mem: <gesamt> <belegt> ..." -> [gesamt, belegt] in MB.
  function memPair(key) {
    var parts = (values[key] || '').split(/\s+/);
    return [intOf(parts[1]), intOf(parts[2])];
  }
  var temp = intOf(values.temp); // Milligrad Celsius
  var mem = memPair('mem');
  var swap = memPair('swap');
  return {
    cpu_temp_c: temp === null ? null : Math.round(temp / 100) / 10,
    throttled: /^0x[0-9a-fA-F]+$/.test(values.throttled || '') ? values.throttled : null,
    disk_used_pct: intOf(values.disk),
    booted_at: values.boot || null,
    mem_total_mb: mem[0],
    mem_used_mb: mem[1],
    swap_total_mb: swap[0],
    swap_used_mb: swap[1],
    reboot_required: values.reboot === '1',
    security_upgrades_last: values.upgrades || null
  };
}

var payload = {
  anlage: '@GW_ANLAGE_NAME@',
  token: '@GW_STATUS_TOKEN@',
  data: {
    inverter_type: '@GW_INVERTER_PROFILE@',
    inverter_status: inverterStatus,
    soc: numberOf('@GW_SOC_ITEM@'),
    // Leistungswerte (Fronius-Vorzeichen: Batterie + = Entladen,
    // Netz + = Bezug, - = Einspeisung); null wenn kein Item verknuepft ist.
    // Das konfigurierte Batterieleistungs-Item der Anlage kommt zuerst
    // (Platzhalter; leer, wenn keins konfiguriert ist - firstNumberOf
    // ueberspringt das dann), danach die ueblichen Itemnamen je Hersteller.
    battery_power_w: firstNumberOf(['@GW_BATTERY_POWER_ITEM@', 'Fronius_Symo_Inverter_Battery_Power']),
    grid_power_w: firstNumberOf(['@GW_GRID_POWER_ITEM@', 'Fronius_Symo_Inverter_Grid_Power']),
    pv_power_w: firstNumberOf(['@GW_PV_POWER_ITEM@', 'Fronius_Symo_Inverter_Solar_Plant_Power']),
    load_power_w: firstNumberOf(['Fronius_Symo_Inverter_Load_Power']),
    hauptschalter: stateOf('Stromkreis_Aktiv'),
    ladesperre_aktiv: stateOf('Stromkreis_LADESPERRE_AKTIV'),
    entladung_aktiv: stateOf('Stromkreis_ENTLADUNG_AKTIV'),
    dynamische_leistung: stateOf('Stromkreis_DYNAMISCHE_LEISTUNG'),
    pause_tage: numberOf('Stromkreis_PAUSE_TAGE'),
    batterie_kapazitaet: numberOf('Stromkreis_BATTERIE_KAPAZITAET'),
    ladesperre_lokal: stateOf('Stromkreis_LADESPERRE_LOKAL'),
    ladeleistung_kw: numberOf('Stromkreis_LADELEISTUNG'),
    ladesperre_lokal_ende: stateOf('Stromkreis_LADESPERRE_LOKAL_ENDE'),
    laderegelung: stateOf('Stromkreis_LADEREGELUNG'),
    // Ziel-Ladeleistung der dynamischen Laderegelung; das Item traegt
    // "<watt> W" oder "-" (keine Begrenzung) - numberOf liefert dann null.
    laderegelung_soll_w: numberOf('Stromkreis_LADEREGELUNG_SOLL'),
    // Effektive (sonnengewichtete) Restladezeit bis zur Abend-Deadline;
    // das Item traegt "<stunden> h" oder "-" - numberOf liefert dann null.
    restladezeit_h: numberOf('Stromkreis_RESTLADEZEIT'),
    // Netzladeschutz: aktuelle Netto-Netzladung der Batterie (0 = alles in
    // Ordnung; > 0 zeigt das Dashboard als rote Warnung).
    netzladeschutz: stateOf('Stromkreis_NETZLADESCHUTZ'),
    netzladung_w: numberOf('Stromkreis_NETZLADUNG'),
    // Einspeisung aus der Batterie: aktueller Wert (Regel
    // stromkreis_netzeinspeisung) und aufsummierte Energie seit Inbetriebnahme
    // des Zaehlers (Nutzen-Indikator fuer Besitzer und Gemeinschaft).
    netzeinspeisung_w: numberOf('Stromkreis_BATTERIE_NETZEINSPEISUNG'),
    batterie_netz_kwh: numberOf('Stromkreis_BATTERIE_NETZEINSPEISUNG_KWH'),
    min_battery_charge: numberOf('Stromkreis_MIN_BATTERY_CHARGE'),
    min_entladeleistung_w: numberOf('Minimale_Entladeleistung_Batterieeinspeisung'),
    max_entladeleistung_w: numberOf('Maximale_Entladeleistung_Batterieeinspeisung'),
    wolken_schwelle: numberOf('Stromkreis_LADESPERRE_WOLKEN_SCHWELLE'),
    wolkenvorschau: numberOf('Stromkreis_Wolkenvorschau'),
    wolkenvorschau_zeit: stateOf('Stromkreis_Wolkenvorschau_Zeit'),
    crossover_start: stateOf('Stromkreis_Crossover_Start'),
    crossover_ende: stateOf('Stromkreis_Crossover_Ende'),
    ladesperre_start: stateOf('Stromkreis_Ladesperre_Start'),
    ladesperre_ende: stateOf('Stromkreis_Ladesperre_Ende'),
    ladesperre_datum: stateOf('Stromkreis_Ladesperre_Datum'),
    ladesperre_individuell: stateOf('Stromkreis_Ladesperre_Individuell'),
    entladestart: stateOf('Stromkreis_Entladestart'),
    hauslast_w: numberOf('Stromkreis_HAUSLAST'),
    // Verbleibendes Nacht-Entladebudget (kWh ueber dem Ziel-Ladestand),
    // vom Kern aus Kapazitaet und Hauslast gerechnet; null ohne Schaetzung.
    nachtbudget_kwh: numberOf('Stromkreis_NACHTBUDGET')
  }
};

// Teure Sammler (starten Prozesse, lesen Logs) nur bei der vollen Meldung.
if (voll) {
  payload.data.log_entries = collectLogEntries();
  payload.data.versions = collectVersions();
  payload.data.apt_updates = collectAptUpdates();
  payload.data.system = collectSystemHealth();
}

var response = actions.HTTP.sendHttpPostRequest(url, "application/json", JSON.stringify(payload), 15000);

if (response === null) {
  console.error("[Stromkreis][Status] Keine Antwort von der API erhalten.");
} else {
  try {
    var jsonData = JSON.parse(response);
    if (jsonData.ok) {
      console.log("[Stromkreis][Status] Status gemeldet (Ladestand: " + payload.data.soc + (voll ? ", voll" : "") + ").");
      // Der Betreiber hat am Dashboard "Paket aktualisieren" gedrueckt: Marker
      // fuer den root-Timer stromkreis-update ablegen (09-install-updater.sh), der
      // das Paket innerhalb von 10 Minuten neu einspielt.
      if (jsonData.update === true) {
        try {
          actions.Exec.executeCommandLine(time.Duration.ofSeconds(5), "/bin/sh", "-c", "touch '@GW_UPDATE_FLAG@'");
          console.log("[Stromkreis][Status] Paket-Update vom Dashboard angefordert - stromkreis-update fuehrt es in Kuerze aus.");
        } catch (e) {
          console.error("[Stromkreis][Status] Update-Marker konnte nicht angelegt werden: " + e);
        }
      }
    } else {
      console.error("[Stromkreis][Status] API-Fehler: " + (jsonData.error || response));
    }
  } catch (e) {
    console.error("[Stromkreis][Status] Unerwartete Antwort: " + response);
  }
}
