#!/usr/bin/env python3
"""Fail-Safe-Reset fuer eine Sigenergy SigenStor (Remote EMS), ohne openHAB.

Schreibt das Werksverhalten der Anlage - Remote EMS enable (40029) = 0,
derselbe eine Write wie gwReset() in adapter.js - und prueft per Read-back,
dass das Register wirklich auf 0 steht. Die Anlage folgt danach wieder
ihrem konfigurierten EMS-Modus (Eigenverbrauch, TOU, ...); Modus- und
Limit-Register (40031, 40034, 40036) bleiben unangetastet, sie wirken ohne
Remote EMS nicht.

Aufgerufen vom root-Timer stromkreis-failsafe (setup/10-install-failsafe.sh),
wenn openHAB keinen Heartbeat mehr schreibt oder nicht laeuft, und vom
Boot-Reset. Nur Standardbibliothek; der Modbus-Client entspricht dem in
spike_sigenstor.py, bewusst ohne Import daraus, damit der Produktionspfad
nicht an einem Diagnosewerkzeug haengt. Reads laufen wie im Profil ueber
FC04 (auch fuer die beschreibbaren Register), Writes ueber FC06.

    failsafe_reset.py --host 192.168.1.50 [--port 502] [--unit 247]
    failsafe_reset.py --host 192.168.1.50 --reads     # nur lesen, nichts schreiben

Wie der Adapter schreibt das Skript nur, wenn die Anlage wie eine SigenStor
antwortet: EMS work mode (30003) lesbar und 0..10, Nennentladeleistung
(30070) plausibel. Besteht die Pruefung nicht, hat der Adapter dort auch
nie kommandiert - es gibt nichts zurueckzusetzen.

Exit 0  Reset geschrieben und per Read-back bestaetigt (bzw. --reads gelungen)
Exit 1  Anlage nicht erreichbar oder Modbus-Fehler
Exit 2  Plausibilitaetspruefung nicht bestanden (nichts geschrieben)
Exit 3  Write angenommen, Read-back weicht ab
"""

import argparse
import socket
import struct
import sys
import time

# Registerkarte Anlagenebene (Sigenergy Modbus Protocol V1.7, literal adressiert)
REG_EMS_MODE = 30003        # U16, 7 = Remote EMS aktiv
REG_MAX_ACTIVE = 30010      # U32, W
REG_SOC = 30014             # U16, % * 10
REG_RATED_DISCHARGE = 30070 # U32, W
REG_REMOTE_ENABLE = 40029   # U16, 0/1 - das Reset-Register
REG_CTRL_BLOCK = 40029      # 40029..40037: enable, phase ctrl, mode, 3 x U32-Limits
CTRL_LEN = 9

# Werksverhalten: Remote EMS aus (wie SIGEN-Reset im Adapter)
RESET_REMOTE_ENABLE = 0

# Plausibilitaetsfenster wie im Adapter (__gwSgGuard)
EMS_MODE_MAX = 10
RATED_MIN_W = 100
RATED_MAX_W = 1000000

# Socket-Timeout: der Timer darf nie haengen; Protokoll V1.7 verlangt
# ausserdem >= 1 s Abstand zwischen Requests ("Interaction timeout").
MODBUS_TIMEOUT_S = 5.0
REQUEST_PAUSE_S = 1.0


class ModbusError(Exception):
    CODES = {1: "Illegal function", 2: "Illegal data address",
             3: "Illegal data value", 4: "Slave device failure",
             10: "Gateway path unavailable", 11: "Gateway target failed"}

    def __init__(self, fc, code):
        name = self.CODES.get(code, f"Code {code}")
        super().__init__(f"Modbus-Exception auf FC{fc}: {name} (0x{code:02X})")


class Client:
    """Minimaler Modbus-TCP-Client: FC04 lesen, FC06 schreiben."""

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

    def read_input(self, address, count):
        resp = self._request(struct.pack(">BHH", 4, address, count))
        return list(struct.unpack(f">{count}H", resp[2:2 + count * 2]))

    def write(self, address, value):
        self._request(struct.pack(">BHH", 6, address, value & 0xFFFF))


def u32(words):
    return (words[0] << 16) | words[1]


def read_state(dev):
    """Liest Modus, Nennleistung und den Remote-EMS-Block in einem Rutsch."""
    ems_mode = dev.read_input(REG_EMS_MODE, 1)[0]
    rated_w = u32(dev.read_input(REG_RATED_DISCHARGE, 2))
    ctrl = dev.read_input(REG_CTRL_BLOCK, CTRL_LEN)
    return {
        "ems_mode": ems_mode,
        "rated_w": rated_w,
        "enable": ctrl[0],
        "mode": ctrl[2],
        "chg_limit_w": u32(ctrl[3:5]),
        "dis_limit_w": u32(ctrl[5:7]),
        "pv_limit_w": u32(ctrl[7:9]),
    }


def guard_ok(state):
    return (0 <= state["ems_mode"] <= EMS_MODE_MAX
            and RATED_MIN_W <= state["rated_w"] <= RATED_MAX_W)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", required=True, help="IP der SigenStor (Energy Controller)")
    parser.add_argument("--port", type=int, default=502)
    parser.add_argument("--unit", type=int, default=247,
                        help="Slave-Adresse der Anlagenebene (Vorgabe 247)")
    parser.add_argument("--reads", action="store_true",
                        help="nur die aktuellen Werte anzeigen, nichts schreiben")
    args = parser.parse_args()

    dev = Client(args.host, args.port, args.unit)
    try:
        before = read_state(dev)
        if args.reads:
            soc = dev.read_input(REG_SOC, 1)[0] / 10
            max_w = u32(dev.read_input(REG_MAX_ACTIVE, 2))
            print(f"EMS work mode {before['ems_mode']}, SoC {soc:.1f}%, Anlagenmaximum {max_w} W,"
                  f" Nennentladeleistung {before['rated_w']} W")
            print(f"Remote EMS enable {before['enable']}, Modus {before['mode']},"
                  f" Ladelimit {before['chg_limit_w']} W, Entladelimit {before['dis_limit_w']} W,"
                  f" PV-Limit {before['pv_limit_w']} W"
                  f" (Plausibilitaet {'ok' if guard_ok(before) else 'NICHT bestanden'})")
            return 0

        if not guard_ok(before):
            print(f"keine SigenStor-Antwort (EMS work mode {before['ems_mode']},"
                  f" Nennentladeleistung {before['rated_w']} W) - nichts geschrieben")
            return 2

        # Derselbe eine Write wie gwReset() im Adapter
        dev.write(REG_REMOTE_ENABLE, RESET_REMOTE_ENABLE)

        after = read_state(dev)
    except (OSError, ModbusError, ConnectionError) as e:
        print(f"{args.host}:{args.port} Unit {args.unit}: {e}")
        return 1
    finally:
        dev.close()

    ok = after["enable"] == RESET_REMOTE_ENABLE
    print(f"vorher Remote EMS enable {before['enable']} (Modus {before['mode']},"
          f" Entladelimit {before['dis_limit_w']} W)"
          f" -> nachher Remote EMS enable {after['enable']}"
          f" ({'bestaetigt' if ok else 'ABWEICHUNG'})")
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
