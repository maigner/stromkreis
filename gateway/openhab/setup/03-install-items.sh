#!/usr/bin/env bash
# ============================================================================
# 03 - Items und Persistence fuer das Batteriemanagement.
#
# Legt NICHT das SoC-Item an - das entsteht beim Verknuepfen des soc-Channels
# des Fronius Things in der Main UI und wird hier nur referenziert.
# ============================================================================
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
require_openhab
load_config

# --- Batterie-Items -----------------------------------------------------------
# Bei der automatischen Einrichtung (Thing-UID *:stromkreis:*) verwaltet Stromkreis auch die
# Batterie-Items samt Channel-Verknuepfung - ganz ohne Main UI. Beim
# klassischen Weg entstehen sie dort beim Verknuepfen der Channels und werden
# hier nur referenziert.
battery_items=""
battery_note="// Nicht enthalten: ${SOC_ITEM}
// Dieses Item entsteht beim Verknuepfen des Ladestands-Channels in der Main UI."
case "$INVERTER_THING_UID" in
  *:stromkreis:*)
    battery_note="// Enthalten sind auch die Batterie-Items (automatische Einrichtung)."
    if type inverter_battery_items >/dev/null 2>&1; then
      # Das Profil liefert seine Item-Liste selbst - noetig, wenn die
      # Messwerte an verschiedenen Things haengen oder zusaetzliche
      # Steuer-Items gebraucht werden (z. B. Modbus-Register).
      battery_items="
// Batterie-Items - verknuepft mit den automatisch angelegten Things
$(inverter_battery_items)"
    else
      battery_items="
// Batterie-Items - verknuepft mit dem automatisch angelegten Thing
Number:Dimensionless ${SOC_ITEM} \"Ladestand Batterie [%.0f %%]\" <batterylevel> (Stromkreis) { channel=\"${INVERTER_THING_UID}:${INVERTER_SOC_CHANNEL}\", unit=\"%\" }"
      if [ -n "$BATTERY_POWER_ITEM" ] && [ -n "$INVERTER_BATTERY_POWER_CHANNEL" ]; then
        battery_items="${battery_items}
Number:Power ${BATTERY_POWER_ITEM} \"Batterieleistung [%.0f W]\" <energy> (Stromkreis) { channel=\"${INVERTER_THING_UID}:${INVERTER_BATTERY_POWER_CHANNEL}\", unit=\"W\" }"
      fi
      if [ -n "$GRID_POWER_ITEM" ] && [ -n "$INVERTER_GRID_POWER_CHANNEL" ]; then
        battery_items="${battery_items}
Number:Power ${GRID_POWER_ITEM} \"Netzleistung [%.0f W]\" <energy> (Stromkreis) { channel=\"${INVERTER_THING_UID}:${INVERTER_GRID_POWER_CHANNEL}\", unit=\"W\" }"
      fi
      if [ -n "$PV_POWER_ITEM" ] && [ -n "$INVERTER_PV_POWER_CHANNEL" ]; then
        battery_items="${battery_items}
Number:Power ${PV_POWER_ITEM} \"PV-Leistung [%.0f W]\" <solarplant> (Stromkreis) { channel=\"${INVERTER_THING_UID}:${INVERTER_PV_POWER_CHANNEL}\", unit=\"W\" }"
      fi
    fi
    ;;
esac

# --- Items ------------------------------------------------------------------
install_file "$OPENHAB_CONF/items/stromkreis.items" <<EOF
// ============================================================================
// Stromkreis Speichermanagement
// GENERIERT von 03-install-items.sh - Aenderungen gehen beim naechsten Lauf
// verloren. Anpassungen stattdessen im Setup-Skript vornehmen.
//
${battery_note}
// ============================================================================
${battery_items}

// Hauptschalter - ohne ON tut die Steuerung nichts
Switch Stromkreis_Aktiv "Batteriemanagement aktivieren" <switch> (Stromkreis)

// Von der Plattform-API befuellt
Number Stromkreis_Wolkenvorschau      "Bewoelkungsvorhersage [%.0f %%]" <sun>  (Stromkreis)
String Stromkreis_Wolkenvorschau_Zeit "Wolkenvorschau abgerufen [%s]"   <time> (Stromkreis)
String Stromkreis_Crossover_Start     "Crossover Start [%s]"            <time> (Stromkreis)
String Stromkreis_Crossover_Ende      "Crossover Ende [%s]"             <time> (Stromkreis)
String Stromkreis_Ladesperre_Start    "Ladesperre ab [%s]"              <time> (Stromkreis)
String Stromkreis_Ladesperre_Ende     "Ladesperre bis [%s]"             <time> (Stromkreis)
String Stromkreis_Ladesperre_Datum    "Ladesperre-Fenster fuer [%s]"    <calendar> (Stromkreis)
// ON, wenn das Sperr-Ende von der Token-API individuell fuer diese Anlage
// berechnet wurde (aus Erzeugungsprofil, Kapazitaet und Ladeleistung) -
// die Steuerung uebernimmt es dann unveraendert
Switch Stromkreis_Ladesperre_Individuell "Sperr-Ende individualisiert"  <switch> (Stromkreis)
// Stundendaten fuer die Laderegelung (JSON mit datum/zeit/stunden):
// Wolken_Stunden = stuendliche Bewoelkung des restlichen Tages,
// Ladefaktoren = stuendliche Ladefaktoren des Erzeugungsprofils samt
// Abend-Deadline (Token-API); '-' = keine Daten
String Stromkreis_Wolken_Stunden      "Wolken je Stunde (intern) [%s]"  <settings> (Stromkreis)
String Stromkreis_Ladefaktoren        "Ladefaktoren (intern) [%s]"      <settings> (Stromkreis)
// Entladestart der Nacht von der Token-API: erster Slot, in dem die
// Gemeinschaft laut Prognose deutlich im Defizit ist (HH:MM); '-' = kein
// Wert, die Steuerung startet dann beim Abend-Crossover plus Abstand
String Stromkreis_Entladestart        "Entladung ab [%s]"               <time>   (Stromkreis)

// Vom Mitglied einstellbar
Number Stromkreis_MIN_BATTERY_CHARGE                       "Minimaler Ladestand Batterie [%.0f %%]" <batterylevel> (Stromkreis)
Number Minimale_Entladeleistung_Batterieeinspeisung "Minimale Entladeleistung [%.0f W]"      <energy>       (Stromkreis)
Number Maximale_Entladeleistung_Batterieeinspeisung "Maximale Entladeleistung [%.0f W]"      <energy>       (Stromkreis)

// Pause: solange > 0 setzt Stromkreis aus (der Wechselrichter arbeitet wie ab
// Werk); die Regel stromkreis_pause.js zaehlt den Wert jede Nacht um 1 herunter
Number Stromkreis_PAUSE_TAGE "Pause (verbleibende Tage) [%.0f]" <calendar> (Stromkreis)

// Ladesperre am Vormittag (Fenster kommt aus der Tagesprognose der API)
Switch Stromkreis_LADESPERRE_AKTIV            "Ladesperre bei Sonnenprognose"      <switch> (Stromkreis)
Number Stromkreis_LADESPERRE_WOLKEN_SCHWELLE  "Wolken-Schwelle Ladesperre [%.0f %%]" <sun>  (Stromkreis)

// Forcierte Entladung in der Nacht (Fenster kommt aus den Crossover-Zeiten)
Switch Stromkreis_ENTLADUNG_AKTIV             "Forcierte Entladung nachts"         <switch> (Stromkreis)

// Dynamische Entladeleistung: die Steuerung schaetzt die Batteriekapazitaet
// aus der Ladestandsaenderung waehrend der Entladung und leitet daraus die
// Entladeleistung ab. Stromkreis_KAPAZITAET_MESSUNG ist interner Zustand (JSON).
Switch Stromkreis_DYNAMISCHE_LEISTUNG   "Entladeleistung an Batteriegroesse anpassen" <switch>  (Stromkreis)
Number Stromkreis_BATTERIE_KAPAZITAET   "Geschaetzte Batteriekapazitaet [%.1f kWh]"   <battery> (Stromkreis)
String Stromkreis_KAPAZITAET_MESSUNG    "Kapazitaetsschaetzung (intern) [%s]"         <settings> (Stromkreis)

// Lokale Ladesperre: die Steuerung errechnet das Sperr-Ende selbst aus
// Batteriekapazitaet und gelernter Ladeleistung - die Batterie beginnt so
// spaet wie moeglich zu laden und ist am Abend trotzdem voll. Solange die
// Schaetzungen fehlen, gilt das Server-Ende aus der Tagesprognose.
// Stromkreis_LADERATE_MESSUNG ist interner Zustand (JSON).
Switch Stromkreis_LADESPERRE_LOKAL      "Ladesperre-Ende selbst berechnen"            <switch>   (Stromkreis)
Number Stromkreis_LADELEISTUNG          "Geschaetzte Ladeleistung [%.1f kW]"          <energy>   (Stromkreis)
String Stromkreis_LADERATE_MESSUNG      "Ladeleistungsschaetzung (intern) [%s]"       <settings> (Stromkreis)
String Stromkreis_LADESPERRE_LOKAL_ENDE "Lokales Ladesperre-Ende [%s]"                <time>     (Stromkreis)

// Laderegelung: statt des harten Sperrfensters wird die Ladeleistung
// dynamisch geregelt - die Batterie laedt den ganzen Tag gerade schnell
// genug, um am Abend voll zu sein, der restliche PV-Ueberschuss fliesst
// laufend ins Netz. Braucht belastbare Kapazitaets- und Ladeleistungs-
// schaetzung, sonst gilt das Sperrfenster als Rueckfall.
// Stromkreis_LADEREGELUNG_STATUS ist interner Zustand (JSON).
Switch Stromkreis_LADEREGELUNG          "Ladeleistung dynamisch regeln"               <switch>   (Stromkreis)
String Stromkreis_LADEREGELUNG_SOLL     "Ziel-Ladeleistung [%s]"                      <energy>   (Stromkreis)
String Stromkreis_LADEREGELUNG_STATUS   "Laderegelung (intern) [%s]"                  <settings> (Stromkreis)
// Effektive (sonnengewichtete) Restladezeit bis zur Abend-Deadline, aus
// den Stundendaten integriert; '-' = gerade nicht berechenbar
String Stromkreis_RESTLADEZEIT          "Effektive Restladezeit [%s]"                 <time>     (Stromkreis)

// Netzladeschutz: die Batterie laedt nur aus PV, nie aus dem Netz. Erkennt
// die Steuerung mehrere Zyklen in Folge Netto-Netzladung (Batterie laedt
// und gleichzeitig wird bezogen), sperrt sie das Laden - ausser bei fast
// leerer Batterie (Schutzladung des Wechselrichters). Stromkreis_NETZLADUNG zeigt
// die aktuelle Netto-Netzladung; Stromkreis_NETZLADE_WAECHTER ist interner
// Zustand (JSON).
Switch Stromkreis_NETZLADESCHUTZ        "Netzladeschutz (nur aus PV laden)"           <shield>   (Stromkreis)
Number Stromkreis_NETZLADUNG            "Ladung aus dem Netz [%.0f W]"                <energy>   (Stromkreis)
String Stromkreis_NETZLADE_WAECHTER     "Netzladeschutz (intern) [%s]"                <settings> (Stromkreis)

// Hauslast (gelernt aus dem naechtlichen Ladestandsabfall ohne
// Entladebefehl; Stromkreis_HAUSLAST_MESSUNG ist interner Zustand, JSON) und das
// daraus vom Kern gerechnete Nacht-Entladebudget: so viel kWh duerfen
// heute Nacht noch ins Netz, ohne dass die Batterie dem eigenen Haus bis
// zum naechsten Gemeinschafts-Ueberschuss fehlt (NULL ohne Schaetzung).
Number Stromkreis_HAUSLAST              "Geschaetzte Hauslast [%.0f W]"               <energy>   (Stromkreis)
String Stromkreis_HAUSLAST_MESSUNG      "Hauslastschaetzung (intern) [%s]"            <settings> (Stromkreis)
Number Stromkreis_NACHTBUDGET           "Nacht-Entladebudget [%.1f kWh]"              <energy>   (Stromkreis)

// Berechnet von stromkreis_netzeinspeisung.js aus Batterie- und Netzleistung:
// Anteil der Batterie-Entladung, der tatsaechlich ins Netz fliesst (der
// Rest versorgt den Haushalt). Bleibt NULL, wenn Batterieleistungs- oder
// Netzleistungs-Item fehlen.
Number Stromkreis_BATTERIE_NETZEINSPEISUNG "Netzeinspeisung aus der Batterie [%.0f W]" <energy> (Stromkreis)

// Einspeise-Zaehler: von core.js pro Zyklus aufsummierte Energie, die aus
// der Batterie ins Netz (an die Gemeinschaft) geflossen ist - der
// Nutzen-Indikator fuer Besitzer und EEG. Stromkreis_NETZEINSPEISUNG_ZAEHLER ist
// interner Zustand (JSON, praeziser Stand samt Zeitstempel).
Number Stromkreis_BATTERIE_NETZEINSPEISUNG_KWH "Batterie ins Netz gesamt [%.2f kWh]"  <energy>   (Stromkreis)
String Stromkreis_NETZEINSPEISUNG_ZAEHLER  "Einspeise-Zaehler (intern) [%s]"          <settings> (Stromkreis)
EOF

# --- Persistence ------------------------------------------------------------
# Ohne restoreOnStartup stehen die Einstellungen nach einem Neustart auf NULL
# und die Steuerung bricht mit "invalid value" ab.
if [ "$INSTALL_PERSISTENCE" = "1" ]; then
  # Optionale Profil-Items (INVERTER_PERSIST_ITEMS, Leerzeichen-getrennt),
  # die wie die Kern-Einstellungen einen Neustart ueberleben muessen -
  # z. B. bei der Installation gemerkte Werkswerte der Anlage.
  profile_persist=""
  for item in ${INVERTER_PERSIST_ITEMS:-}; do
    profile_persist="${profile_persist}    ${item},
"
  done

  install_file "$OPENHAB_CONF/persistence/mapdb.persist" <<EOF
// ============================================================================
// Stromkreis Speichermanagement
// GENERIERT von 03-install-items.sh
//
// Sichert die Einstellungen und die zuletzt geholten API-Werte, damit sie
// einen Neustart ueberleben. Die Wolkenvorschau ist trotzdem sicher: die
// Steuerung prueft ueber Stromkreis_Wolkenvorschau_Zeit, ob sie veraltet ist.
//
// Kein Strategies-Block: everyChange und restoreOnStartup sind eingebaut,
// und Default-Strategien versteht openHAB seit 5.1 nicht mehr.
// ============================================================================

Items {
${profile_persist}    Stromkreis_Aktiv,
    Stromkreis_Wolkenvorschau,
    Stromkreis_Wolkenvorschau_Zeit,
    Stromkreis_Crossover_Start,
    Stromkreis_Crossover_Ende,
    Stromkreis_Ladesperre_Start,
    Stromkreis_Ladesperre_Ende,
    Stromkreis_Ladesperre_Datum,
    Stromkreis_Ladesperre_Individuell,
    Stromkreis_Wolken_Stunden,
    Stromkreis_Ladefaktoren,
    Stromkreis_Entladestart,
    Stromkreis_MIN_BATTERY_CHARGE,
    Minimale_Entladeleistung_Batterieeinspeisung,
    Maximale_Entladeleistung_Batterieeinspeisung,
    Stromkreis_PAUSE_TAGE,
    Stromkreis_LADESPERRE_AKTIV,
    Stromkreis_LADESPERRE_WOLKEN_SCHWELLE,
    Stromkreis_ENTLADUNG_AKTIV,
    Stromkreis_DYNAMISCHE_LEISTUNG,
    Stromkreis_BATTERIE_KAPAZITAET,
    Stromkreis_KAPAZITAET_MESSUNG,
    Stromkreis_LADESPERRE_LOKAL,
    Stromkreis_LADELEISTUNG,
    Stromkreis_LADERATE_MESSUNG,
    Stromkreis_LADESPERRE_LOKAL_ENDE,
    Stromkreis_LADEREGELUNG,
    Stromkreis_LADEREGELUNG_SOLL,
    Stromkreis_LADEREGELUNG_STATUS,
    Stromkreis_RESTLADEZEIT,
    Stromkreis_NETZLADESCHUTZ,
    Stromkreis_NETZLADE_WAECHTER,
    Stromkreis_BATTERIE_NETZEINSPEISUNG_KWH,
    Stromkreis_NETZEINSPEISUNG_ZAEHLER,
    Stromkreis_HAUSLAST,
    Stromkreis_HAUSLAST_MESSUNG,
    Stromkreis_NACHTBUDGET
        : strategy = everyChange, restoreOnStartup
}
EOF

  # rrd4j: Zeitreihen fuer Analyze/Diagramme in der Main UI. Nur Zahlenwerte;
  # everyMinute ist fuer rrd4j Pflicht (die Archive erwarten lueckenlose
  # Minutenwerte). Kein restoreOnStartup - das erledigt mapdb, und die
  # Batteriewerte kommen ohnehin frisch vom Binding. Ein hier gelistetes,
  # (noch) nicht vorhandenes Item ist unschaedlich - beim klassischen Weg
  # entsteht das SoC-Item erst in der Main UI.
  battery_persist="    ${SOC_ITEM},"
  if [ -n "$BATTERY_POWER_ITEM" ]; then
    battery_persist="${battery_persist}
    ${BATTERY_POWER_ITEM},"
  fi
  if [ -n "$GRID_POWER_ITEM" ]; then
    battery_persist="${battery_persist}
    ${GRID_POWER_ITEM},"
  fi
  if [ -n "$PV_POWER_ITEM" ]; then
    battery_persist="${battery_persist}
    ${PV_POWER_ITEM},"
  fi
  install_file "$OPENHAB_CONF/persistence/rrd4j.persist" <<EOF
// ============================================================================
// Stromkreis Speichermanagement
// GENERIERT von 03-install-items.sh
//
// Zeitreihen fuer Analyze/Diagramme in der Main UI (rrd4j ist der
// Standard-Persistence-Dienst, siehe runtime.cfg). Die Einstellungen
// selbst sichert mapdb.persist.
// ============================================================================

// Default-Strategien ('default = ...') versteht openHAB seit 5.1 nicht mehr -
// jede Item-Zeile nennt ihre Strategien deshalb selbst.
Strategies {
    everyMinute : "0 * * * * ?"
}

Items {
${battery_persist}
    Stromkreis_Wolkenvorschau,
    Stromkreis_MIN_BATTERY_CHARGE,
    Minimale_Entladeleistung_Batterieeinspeisung,
    Maximale_Entladeleistung_Batterieeinspeisung,
    Stromkreis_PAUSE_TAGE,
    Stromkreis_LADESPERRE_WOLKEN_SCHWELLE,
    Stromkreis_BATTERIE_KAPAZITAET,
    Stromkreis_LADELEISTUNG,
    Stromkreis_HAUSLAST,
    Stromkreis_NETZLADUNG,
    Stromkreis_BATTERIE_NETZEINSPEISUNG
        : strategy = everyChange, everyMinute
}
EOF

  # rrd4j als Standard-Dienst: Analyze/Diagramme fragen ohne explizite Wahl
  # den Standard ab, und mapdb kann nicht charten (nur letzter Wert).
  # restoreOnStartup haengt nicht vom Standard ab.
  runtime_cfg_set "org.openhab.persistence:default" "rrd4j"

  # Ohne das hier bleiben frisch geschriebene .persist-Modelle wirkungslos,
  # wenn openHAB die Persistence-Addons noch installiert - siehe Helfer.
  persistence_activate mapdb rrd4j
else
  log "INSTALL_PERSISTENCE=0 - Persistence uebersprungen."
  warn "Ohne Persistence stehen die Einstellungen nach einem Neustart auf NULL."
fi

log "Items installiert."
