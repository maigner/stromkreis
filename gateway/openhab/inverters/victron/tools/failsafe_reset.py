#!/usr/bin/env python3
"""Fail-Safe-Reset fuer ein Victron GX-Geraet (ESS-Settings), ohne openHAB.

Schreibt das Werksverhalten der Anlage - ESS grid setpoint (2700) und DVCC
MaxChargeCurrent (2705) auf die Werkswerte, dieselben zwei Writes in
derselben Reihenfolge wie gwReset() in adapter.js - und prueft per
Read-back, dass beide Register stehen. Die Anlage folgt danach wieder
ihrer normalen ESS-Regelung (Eigenverbrauch).

Die Werkswerte merkt sich die Installation in den Items
Stromkreis_VIC_ResetSetpointW / Stromkreis_VIC_ResetMaxChargeA (inverter_verify
im Profil). Dieses Skript laeuft ohne openHAB und bekommt sie deshalb als
Argumente (--setpoint, --max-charge); das Profil liest sie, solange openHAB
antwortet, per REST aus den Items und nimmt sonst die Rueckfallwerte des
Adapters: Setpoint 50 W (Victron-Vorgabe laut ESS-Handbuch),
MaxChargeCurrent -1 (unbegrenzt).

Aufgerufen vom root-Timer stromkreis-failsafe (setup/10-install-failsafe.sh),
wenn openHAB keinen Heartbeat mehr schreibt oder nicht laeuft, und vom
Boot-Reset. Nur Standardbibliothek, eigener Modbus-TCP-Client (Unit-ID 100,
Halteregister: Reads FC03, Writes FC06, int16 als Zweierkomplement).

    failsafe_reset.py --host 192.168.1.50 [--port 502] [--unit 100] [--setpoint 50] [--max-charge -1]
    failsafe_reset.py --host 192.168.1.50 --reads     # nur lesen, nichts schreiben

Wie der Adapter schreibt das Skript nur, wenn das GX wie erwartet
antwortet: ESS-Modus (2902) 1 oder 2 (3 = Externe Steuerung, ein anderes
EMS steuert) und Ladestand (843) 0..100. Besteht die Pruefung nicht, hat der
Adapter dort auch nie kommandiert - es gibt nichts zurueckzusetzen.

Exit 0  Reset geschrieben und per Read-back bestaetigt (bzw. --reads gelungen)
Exit 1  GX nicht erreichbar oder Modbus-Fehler
Exit 2  Plausibilitaetspruefung nicht bestanden (nichts geschrieben)
Exit 3  Writes angenommen, Read-back weicht ab
"""

import argparse
import socket
import struct
import sys
import time

# Registerkarte Systemebene (dbus_modbustcp attributes.csv, literal adressiert)
REG_BATT_BLOCK = 840     # 840..843: Spannung, Strom, Leistung, SoC
BATT_LEN = 4
OFF_BATT_POWER = 2       # 842, S16, + laden
OFF_SOC = 3              # 843, U16, %
REG_SET_BLOCK = 2700     # 2700..2708: ESS-Settings
SET_LEN = 9
OFF_SETPOINT = 0         # 2700, S16, W (+ Bezug, - Einspeisung)
OFF_MAX_CHARGE = 5       # 2705, S16, A (-1 = unbegrenzt)
OFF_MAX_FEEDIN = 6       # 2706, S16, W / 100 (-1 = unbegrenzt)
REG_ESS_BLOCK = 2900     # 2900..2902: BatteryLife, Minimum SoC, Modus
ESS_LEN = 3
OFF_BL_STATE = 0         # 2900
OFF_MIN_SOC = 1          # 2901, % * 10
OFF_ESS_MODE = 2         # 2902, 1/2 = ESS, 3 = Externe Steuerung
REG_SETPOINT = REG_SET_BLOCK + OFF_SETPOINT
REG_MAX_CHARGE = REG_SET_BLOCK + OFF_MAX_CHARGE

# Rueckfallwerte wie VIC_DEFAULT_* im Adapter
DEFAULT_SETPOINT_W = 50
DEFAULT_MAX_CHARGE_A = -1

# Socket-Timeout: der Timer darf nie haengen
MODBUS_TIMEOUT_S = 5.0
REQUEST_PAUSE_S = 0.1


class ModbusError(Exception):
    CODES = {1: "Illegal function", 2: "Illegal data address",
             3: "Illegal data value", 4: "Slave device failure",
             10: "Gateway path unavailable", 11: "Gateway target failed"}

    def __init__(self, fc, code):
        name = self.CODES.get(code, f"Code {code}")
        super().__init__(f"Modbus-Exception auf FC{fc}: {name} (0x{code:02X})")


class Client:
    """Minimaler Modbus-TCP-Client: FC03 lesen, FC06 schreiben."""

    def __init__(self, host, port, unit):
        self.host, self.port, self.unit = host, port, unit
        self.sock = None
        self.tid = 0
        self.last_request = 0.0

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=MODBUS_TIMEOUT_S)
        self.sock.settimeout(MODBUS_TIMEOUT_S)

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _recvall(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("Verbindung geschlossen")
            data += chunk
        return data

    def _request(self, pdu):
        wait = REQUEST_PAUSE_S - (time.monotonic() - self.last_request)
        if wait > 0:
            time.sleep(wait)
        if self.sock is None:
            self.connect()
        self.tid = (self.tid + 1) % 0xFFFF
        self.sock.sendall(struct.pack(">HHHB", self.tid, 0, len(pdu) + 1, self.unit) + pdu)
        header = self._recvall(7)
        _tid, _proto, length, _unit = struct.unpack(">HHHB", header)
        resp = self._recvall(length - 1)
        self.last_request = time.monotonic()
        if resp[0] & 0x80:
            raise ModbusError(resp[0] & 0x7F, resp[1])
        return resp

    def read(self, address, count):
        resp = self._request(struct.pack(">BHH", 3, address, count))
        return list(struct.unpack(f">{count}H", resp[2:2 + count * 2]))

    def write(self, address, value):
        self._request(struct.pack(">BHH", 6, address, value & 0xFFFF))


def s16(raw):
    return raw - 0x10000 if raw >= 0x8000 else raw


def read_state(dev):
    batt = dev.read(REG_BATT_BLOCK, BATT_LEN)
    settings = dev.read(REG_SET_BLOCK, SET_LEN)
    ess = dev.read(REG_ESS_BLOCK, ESS_LEN)
    return {
        "batt_power_w": s16(batt[OFF_BATT_POWER]),
        "soc": batt[OFF_SOC],
        "setpoint_w": s16(settings[OFF_SETPOINT]),
        "max_charge_a": s16(settings[OFF_MAX_CHARGE]),
        "max_feedin_raw": s16(settings[OFF_MAX_FEEDIN]),
        "bl_state": ess[OFF_BL_STATE],
        "min_soc": ess[OFF_MIN_SOC] / 10,
        "ess_mode": ess[OFF_ESS_MODE],
    }


def guard_ok(state):
    return state["ess_mode"] in (1, 2) and 0 <= state["soc"] <= 100


def int16(text):
    value = int(text)
    if value < -32768 or value > 32767:
        raise argparse.ArgumentTypeError(f"{value} passt nicht in int16")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", required=True, help="IP des GX-Geraets")
    parser.add_argument("--port", type=int, default=502)
    parser.add_argument("--unit", type=int, default=100,
                        help="Unit-ID der Systemebene (Vorgabe 100)")
    parser.add_argument("--setpoint", type=int16, default=DEFAULT_SETPOINT_W,
                        help="Werkswert ESS grid setpoint in W (Vorgabe 50)")
    parser.add_argument("--max-charge", type=int16, default=DEFAULT_MAX_CHARGE_A,
                        help="Werkswert DVCC MaxChargeCurrent in A (Vorgabe -1 = unbegrenzt)")
    parser.add_argument("--reads", action="store_true",
                        help="nur die aktuellen Werte anzeigen, nichts schreiben")
    args = parser.parse_args()

    dev = Client(args.host, args.port, args.unit)
    try:
        before = read_state(dev)
        if args.reads:
            print(f"ESS-Modus {before['ess_mode']}, BatteryLife {before['bl_state']},"
                  f" Minimum SoC {before['min_soc']:.1f}%, SoC {before['soc']}%,"
                  f" Batterieleistung {before['batt_power_w']} W")
            print(f"Grid setpoint {before['setpoint_w']} W, MaxChargeCurrent {before['max_charge_a']} A,"
                  f" MaxFeedIn roh {before['max_feedin_raw']}"
                  f" (Plausibilitaet {'ok' if guard_ok(before) else 'NICHT bestanden'})")
            return 0

        if not guard_ok(before):
            print(f"GX nicht im ESS-Betrieb (ESS-Modus {before['ess_mode']}, SoC {before['soc']}%)"
                  f" - nichts geschrieben")
            return 2

        # Reihenfolge wie gwReset() im Adapter: erst Setpoint, dann Ladestrom
        dev.write(REG_SETPOINT, args.setpoint)
        dev.write(REG_MAX_CHARGE, args.max_charge)

        after = read_state(dev)
    except (OSError, ModbusError, ConnectionError) as e:
        print(f"{args.host}:{args.port} Unit {args.unit}: {e}")
        return 1
    finally:
        dev.close()

    ok = (after["setpoint_w"] == args.setpoint
          and after["max_charge_a"] == args.max_charge)
    print(f"vorher Setpoint {before['setpoint_w']} W MaxChargeCurrent {before['max_charge_a']} A"
          f" -> nachher Setpoint {after['setpoint_w']} W MaxChargeCurrent {after['max_charge_a']} A"
          f" ({'bestaetigt' if ok else 'ABWEICHUNG'})")
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
